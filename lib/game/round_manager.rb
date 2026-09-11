module Game
  # Owns the live round of one room and drives it from a thread that ticks four times a second. State changes
  # happen under @mutex; the messages they produce are published after the lock is released. The first
  # GameChannel subscription starts the thread, so it lives inside the Puma process, the only place the
  # development cable adapter reaches browsers from. Between rounds the players vote on the next town: a handful
  # of random candidates plus whatever they type in; the winner becomes the next arena.
  class RoundManager
    TICK_S          = 0.25
    VOTE_MS         = 15_000
    INTERMISSION_MS = 15_000
    ENDED_MS        = 8_000
    CANDIDATES      = 4
    MAX_CANDIDATES  = 9

    @managers = {}
    @lock = Mutex.new

    class << self
      def for(room) = @lock.synchronize { @managers[room] ||= new(room) }
      def reset!(room, **options) = @lock.synchronize { @managers[room]&.stop; @managers[room] = new(room, **options) }
      def shutdown = @lock.synchronize { @managers.each_value(&:stop); @managers.clear }
    end

    attr_reader :room, :round, :players, :vote

    def initialize(room, arena: Arena.new, publish: nil, threaded: true)
      @room, @arena, @threaded = room, arena, threaded
      @publish = publish || ->(payload) { ActionCable.server.broadcast("game:#{room}", payload) }
      @mutex, @players, @round, @vote, @dirty, @seq = Mutex.new, {}, nil, nil, {}, 0
    end

    # returns the `sync` payload for the new subscriber; the same player in several tabs is counted once
    def join(player_id, name, now = Game.now_ms)
      @mutex.synchronize do
        ensure_thread
        p = @players[player_id] ||= Round::Player.new(id: player_id, name:, joined_at: now, tabs: 0)
        p.tabs += 1
        p.name = name
        { now:, you: you(p), round: round_h, vote: vote_h }
      end
    end

    # a vote for one of the candidates or for a typed town, which joins the list when it exists
    def cast(player_id, name, now = Game.now_ms)
      ok, payload = @mutex.synchronize do
        next [ false, { type: "vote", ok: false, reason: "closed" } ] unless @vote && @players[player_id]
        town = @vote[:candidates].find { _1[:name].casecmp?(name) }
        town ||= @vote[:candidates].size < MAX_CANDIDATES && @arena.find_place(name)
        next [ false, { type: "vote", ok: false, reason: "unknown" } ] unless town
        @vote[:candidates] << town unless @vote[:candidates].include?(town)
        @vote[:by][player_id] = town[:name]
        [ true, vote_msg ]
      end
      @publish.call(payload.merge(now:)) if ok
      [ ok, payload ]
    end

    def leave(player_id)
      @mutex.synchronize { (p = @players[player_id]) && (p.tabs -= 1) <= 0 && @players.delete(player_id) }
    end

    def rename(player_id, name)
      @mutex.synchronize { (p = @players[player_id]) && p.name = name }
    end

    def moved(player_id, x, z, vehicle)
      @mutex.synchronize do
        p = @players[player_id] or return
        p.x, p.z = x, z
        p.vehicle = vehicle if vehicle.present?
      end
    end

    # hits: [[key, damage, max], ...]; the verdicts leave with the next tick's `object` message
    def hit(player_id, hits)
      @mutex.synchronize do
        return unless @round&.running? && @players[player_id]
        hits.each { |key, damage, max| (obj = @round.hit(key, damage, max)) && @dirty[obj.key] = obj }
      end
    end

    def teleport(player_id, x, z, now = Game.now_ms)
      act(player_id, now, "teleport") do
        next "status" unless @round&.running?
        next "bounds" unless @round.inside_arena?(x, z)
        { x:, z: }
      end
    end

    # free while no round is running, otherwise it spends the shared action like a teleport does
    def switch(player_id, vehicle, now = Game.now_ms)
      act(player_id, now, "switch", free: !@round&.running?) do |p|
        p.vehicle = vehicle
        { vehicle: }
      end
    end

    def tick(now = Game.now_ms)
      out = @mutex.synchronize do
        msgs = []
        if @vote
          msgs << start_intermission(now, winner) if now >= @vote[:ends_at]
        else
          case @round&.status
          when nil           then msgs << start_vote(now) if @players.any?
          when :intermission then msgs << start_round(now) if now >= @round.next_at
          when :running      then (result = @round.check(now)) && msgs.concat(finish(now, result))
          when :ended        then now >= @round.next_at && (@players.any? ? msgs << start_vote(now) : @round = nil)
          end
        end
        msgs << { type: "object", list: @dirty.values.map { @round.obj_h(_1) } } if @dirty.any?
        @dirty.clear
        msgs.compact
      end
      out.each { @publish.call(_1.merge(now:)) }
    end

    def stop = @thread&.kill

    private

    def ensure_thread
      return unless @threaded
      @thread ||= Thread.new do
        loop do
          sleep TICK_S
          break if stale?
          Rails.application.executor.wrap { tick }
        rescue => e
          Rails.logger.error("[game #{@room}] #{e.class}: #{e.message}")
        end
      end
    end

    # a development reload replaces the class; the old one keeps its thread and must bow out
    def stale? = !::Game::RoundManager.equal?(self.class)

    # The shared 60 s action. The block gets the player and returns a reason string to refuse or a hash of fields
    # to broadcast. Returns [ok, payload]: a success has been published already, a refusal goes back to the asker.
    def act(player_id, now, type, free: false)
      ok, payload = @mutex.synchronize do
        p = @players[player_id] or next [ false, { type:, ok: false, reason: "player" } ]
        reason = "cooldown" if !free && @round && !@round.action_allowed?(p, now)
        fields = reason ? nil : yield(p)
        reason = fields if fields.is_a?(String)
        if reason
          [ false, { type:, ok: false, reason:, next_action_at: @round&.next_action_at(p) } ]
        else
          p.last_action_at = now unless free
          [ true, { type:, id: player_id, now:, next_action_at: @round&.next_action_at(p) }.merge(fields) ]
        end
      end
      @publish.call(payload) if ok
      [ ok, payload ]
    end

    def start_vote(now)
      @vote = { candidates: @arena.candidates(CANDIDATES), by: {}, ends_at: now + VOTE_MS }
      vote_msg
    end

    # the most voted town, a random one among ties, a random candidate when nobody voted
    def winner
      counts = @vote[:by].values.tally
      best = counts.values.max
      pool = best ? @vote[:candidates].select { counts[_1[:name]] == best } : @vote[:candidates]
      pool.sample
    end

    def start_intermission(now, place = nil)
      @vote = nil
      prepared = @arena.prepare(place:) or return
      @players.each_value { _1.last_action_at = nil }         # a fresh arena, fresh actions
      @seq += 1
      @round = Round.new(id: @seq, next_at: now + INTERMISSION_MS, **prepared)
      round_msg
    end

    def start_round(now)
      @round.start!(now, @players.values)
      round_msg
    end

    def finish(now, result)
      x, z = @round.float_at(now)
      blocker = @round.blocker
      @round.end!(now, result)
      @round.next_at = now + ENDED_MS
      ended = { type: "end", result:, x: x.round(1), z: z.round(1) }
      ended.merge!(key: blocker.key, at: blocker.at) if result == :lost && blocker
      [ ended, round_msg ]
    end

    def round_msg = { type: "round", round: round_h }
    def vote_msg = { type: "vote", vote: vote_h }
    def vote_h = @vote && { candidates: @vote[:candidates].map { { name: _1[:name], kind: _1[:kind], votes: @vote[:by].values.count(_1[:name]) } }, by: @vote[:by], ends_at: @vote[:ends_at] }
    def round_h = @round&.to_h(@players.values)
    def you(p) = { id: p.id, name: p.name, next_action_at: @round&.next_action_at(p) }
  end
end
