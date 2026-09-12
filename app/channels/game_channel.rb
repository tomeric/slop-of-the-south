# One room = one stream. Clients send `move` ~10x/second, which the server relays, plus the round-mode actions:
# `hit` reports damage, `fire` shows a shot to the others, `teleport` and `switch` spend the shared action, `vote`
# picks the next town between rounds. The
# room's Game::RoundManager owns the round; a new subscriber gets the whole state in a `sync`.
class GameChannel < ApplicationCable::Channel
  RATES = { "move" => 15, "hit" => 20, "fire" => 10, "debris" => 2, "teleport" => 2, "switch" => 2, "vote" => 2, "rename" => 2 }.freeze   # messages per second
  MAX_HITS = 32
  MAX_DEBRIS = 24

  def subscribed
    @room = params[:room].to_s.presence || "main"
    @name = params[:name].to_s.strip.first(16).presence || "Chauffeur"
    @last = Hash.new(0.0)
    stream_from stream_name
    transmit manager.join(player_id, @name).merge(type: "sync")
    broadcast(type: "join", name: @name)
  end

  def unsubscribed
    manager.leave(player_id)
    broadcast(type: "leave")
  end

  # data: { x, y, z, yaw, pitch, roll, speed, brake, drift, boost, thrust, vehicle } — drift, boost and thrust
  # drive the smoke and flames on other screens, and pitch/roll are there because a real chassis rolls over
  def move(data)
    return unless allowed?("move")
    vehicle = data["vehicle"].to_s.first(16)
    manager.moved(player_id, data["x"].to_f, data["z"].to_f, vehicle)
    broadcast(
      type: "move", name: @name, vehicle:,
      x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f,
      yaw: data["yaw"].to_f, pitch: data["pitch"].to_f, roll: data["roll"].to_f,
      speed: data["speed"].to_f, brake: data["brake"] == true,
      drift: data["drift"] == true, boost: data["boost"] == true, thrust: data["thrust"] == true,
      t: Game.now_ms
    )
  end

  # data: { hits: [{ key, damage, max }, ...] }; the verdicts come back in the manager's `object` messages
  def hit(data)
    return unless allowed?("hit")
    hits = Array(data["hits"]).first(MAX_HITS).filter_map do |h|
      key, damage, max = h["key"].to_s, h["damage"].to_f, h["max"].to_f
      woz = h["woz"].to_i                                         # what the client says the thing is worth, in euros
      [ key, damage, max, (woz if woz.positive?) ] if key.match?(Game::KEY_RE) && damage.positive? && max.positive?
    end
    manager.hit(player_id, hits) if hits.any?
  end

  # data: { kind, x, y, z, yaw }: a shot the other players draw, nothing more
  def fire(data)
    return unless allowed?("fire")
    # mx/my/mz and vx/vy/vz are the muzzle and the launch velocity: a rocket flies an arc now, and the other
    # screens have to be told the same one or their copy lands somewhere else entirely
    shot = %w[mx my mz vx vy vz].to_h { |k| [ k.to_sym, data[k].to_f ] } if data["vx"].present?
    broadcast({ type: "fire", name: @name, kind: data["kind"].to_s.first(16),
                x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f, yaw: data["yaw"].to_f,
                t: Game.now_ms }.merge(shot || {}))
  end

  # data: { x, z }
  # data: { ats: [metres along the route, ...] } — where this client's rubble came to rest. The server buckets them
  # into heaps the parade has to get past; see Game::Round#debris.
  def debris(data)
    return unless allowed?("debris")
    ats = Array(data["ats"]).first(MAX_DEBRIS).filter_map { |a| a.to_f if a.to_f.positive? }
    manager.debris(player_id, ats) if ats.any?
  end

  def teleport(data)
    return unless allowed?("teleport")
    answer manager.teleport(player_id, data["x"].to_f, data["z"].to_f)
  end

  # data: { vehicle }
  def switch(data)
    return unless allowed?("switch")
    answer manager.switch(player_id, data["vehicle"].to_s.first(16))
  end

  # data: { name }: a candidate town or a typed one
  def vote(data)
    return unless allowed?("vote")
    answer manager.cast(player_id, data["name"].to_s.strip.first(40))
  end

  # data: { name }: the next move messages carry it, so everyone's beacon follows
  def rename(data)
    return unless allowed?("rename")
    @name = data["name"].to_s.strip.first(16).presence || @name
    manager.rename(player_id, @name)
  end

  private

  def manager = Game::RoundManager.for(@room)
  def stream_name = "game:#{@room}"

  def allowed?(action)
    now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    return false if now - @last[action] < 1.0 / RATES[action]
    @last[action] = now
  end

  # the manager has broadcast a success itself; a refusal only goes back to the asker
  def answer((ok, payload))
    transmit(payload) unless ok
  end

  def broadcast(payload)
    ActionCable.server.broadcast(stream_name, payload.merge(id: player_id))
  end
end
