module Game
  # One round: the arena, the parade float's motion along the route, every object hit so far and each player's
  # action cooldown. Time is server milliseconds. The float's position is a pure function of started_at and speed,
  # so clients render it from a clock offset without any messages.
  class Round
    CROSSING_MS    = 900_000                      # the float takes 15 minutes edge to edge
    RUBBLE_SHARE   = 0.5                          # a flattened building leaves rubble worth this share of its hit points
    ACTION_MS      = 60_000                       # teleport or vehicle switch, then this long a cooldown
    MAX_HP         = 100_000
    FLOAT          = { length: 12, width: 4 }.freeze
    BUILDING_KINDS = %w[m b].freeze

    MAX_WOZ        = 50_000_000                   # € a client may claim one building is worth (lib/tasks/woz.rake caps it there)

    Obj    = Struct.new(:key, :kind, :x, :z, :at, :hp, :max, :state, :woz, keyword_init: true)   # at: nil for objects off the path
    Player = Struct.new(:id, :name, :vehicle, :joined_at, :last_action_at, :x, :z, :tabs, keyword_init: true)

    attr_reader :id, :status, :result, :arena, :path, :spawn, :speed, :started_at, :ended_at, :obstacles, :objects, :damage
    attr_accessor :next_at

    def initialize(id:, arena:, path:, spawn:, obstacles:, next_at: nil)
      @id, @arena, @path, @spawn, @next_at = id, arena, path, spawn, next_at
      @speed = path[:length] / (CROSSING_MS / 1000.0)
      @obstacles = obstacles.map { Obj.new(**_1, state: :intact) }.sort_by(&:at)
      @objects = @obstacles.to_h { [ _1.key, _1 ] }        # everything touched this round, corridor objects included
      @damage = 0.0                                        # euros of property flattened, everybody's, this round
      @status = :intermission
    end

    def start!(now, players)
      @status, @started_at, @next_at = :running, now, nil
      players.each { _1.last_action_at = nil }
    end

    def end!(now, result)
      @status, @result, @ended_at = :ended, result, now
    end

    def running? = status == :running
    def length = path[:length]
    def ends_at = started_at && started_at + CROSSING_MS
    def travelled(now) = ((now - started_at) / 1000.0 * speed).clamp(0.0, length)

    def float_at(now)
      t = travelled(now) / length
      [ path[:x0] + (path[:x1] - path[:x0]) * t, path[:z0] + (path[:z1] - path[:z0]) * t ]
    end

    def blocker = obstacles.find { _1.state != :gone }

    # :lost when the float's nose reaches something still standing, :won when it reaches the far edge
    def check(now)
      d = travelled(now)
      if (b = blocker) && d >= b.at then :lost
      elsif d >= length then :won
      end
    end

    # One damage report. `max` is pinned when the object is first seen: clients compute it from the object's size,
    # the server does not know sizes. Buildings crumble to rubble at zero and get RUBBLE_SHARE of their hit points
    # back; everything else is gone at once. Returns the object when it changed, nil otherwise.
    def hit(key, damage, max, woz = nil)
      return if damage <= 0
      obj = objects[key] ||= Obj.new(key:, kind: key[0], state: :intact)
      return if obj.state == :gone
      obj.max ||= max.clamp(1, MAX_HP)
      obj.hp ||= obj.max
      obj.woz ||= woz&.clamp(0, MAX_WOZ)
      # The bill, in euros: what this hit actually took off, as a share of the whole. Whoever reports the first hit
      # on a building says what it is worth and nobody can raise it afterwards, and only an intact one can be
      # charged for — so a building adds its own value to the total once and clearing its rubble afterwards is free,
      # however many players are hammering it.
      @damage += obj.woz * [ damage, obj.hp ].min / obj.max if obj.woz && obj.hp.positive? && obj.state == :intact
      obj.hp -= damage
      if obj.hp <= 0 && BUILDING_KINDS.include?(obj.kind) && obj.state == :intact
        obj.state, obj.hp = :rubble, (obj.max * RUBBLE_SHARE).ceil
      elsif obj.hp <= 0
        obj.state, obj.hp = :gone, 0
      end
      obj
    end

    def action_allowed?(player, now) = player.last_action_at.nil? || now - player.last_action_at >= ACTION_MS
    def next_action_at(player) = player.last_action_at && player.last_action_at + ACTION_MS

    def inside_arena?(x, z, margin = 500)
      (x - arena[:cx]).abs <= arena[:half] + margin && (z - arena[:cz]).abs <= arena[:half] + margin
    end

    def to_h(players)
      { id:, status:, result:, arena:, path:, speed: speed.round(4), float: FLOAT, damage: damage.round,
        started_at:, ends_at:, next_at:, spawn:,
        obstacles: obstacles.map { obj_h(_1).merge(kind: _1.kind, x: _1.x, z: _1.z, at: _1.at) },
        objects: objects.values.reject(&:at).map { obj_h(_1) },
        players: players.map { { id: _1.id, name: _1.name, vehicle: _1.vehicle } } }
    end

    def obj_h(o) = { key: o.key, hp: o.hp&.round(1), max: o.max, state: o.state }
  end
end
