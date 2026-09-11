# One room = one stream. Clients send `move` ~10x/second, which the server relays, plus the round-mode actions:
# `hit` reports damage, `fire` shows a shot to the others, `teleport` and `switch` spend the shared action, `vote`
# picks the next town between rounds. The
# room's Game::RoundManager owns the round; a new subscriber gets the whole state in a `sync`.
class GameChannel < ApplicationCable::Channel
  RATES = { "move" => 15, "hit" => 20, "fire" => 10, "teleport" => 2, "switch" => 2, "vote" => 2 }.freeze   # messages per second
  MAX_HITS = 32

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

  # data: { x, y, z, yaw, speed, brake, drift, boost, vehicle } — drift/boost drive the smoke and flames on other screens
  def move(data)
    return unless allowed?("move")
    vehicle = data["vehicle"].to_s.first(16)
    manager.moved(player_id, data["x"].to_f, data["z"].to_f, vehicle)
    broadcast(
      type: "move", name: @name, vehicle:,
      x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f,
      yaw: data["yaw"].to_f, speed: data["speed"].to_f, brake: data["brake"] == true,
      drift: data["drift"] == true, boost: data["boost"] == true,
      t: Game.now_ms
    )
  end

  # data: { hits: [{ key, damage, max }, ...] }; the verdicts come back in the manager's `object` messages
  def hit(data)
    return unless allowed?("hit")
    hits = Array(data["hits"]).first(MAX_HITS).filter_map do |h|
      key, damage, max = h["key"].to_s, h["damage"].to_f, h["max"].to_f
      [ key, damage, max ] if key.match?(Game::KEY_RE) && damage.positive? && max.positive?
    end
    manager.hit(player_id, hits) if hits.any?
  end

  # data: { kind, x, y, z, yaw }: a shot the other players draw, nothing more
  def fire(data)
    return unless allowed?("fire")
    broadcast(type: "fire", name: @name, kind: data["kind"].to_s.first(16),
              x: data["x"].to_f, y: data["y"].to_f, z: data["z"].to_f, yaw: data["yaw"].to_f, t: Game.now_ms)
  end

  # data: { x, z }
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
