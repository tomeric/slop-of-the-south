# Co-op round mode ("Kernkop"): the round state machine, the arena queries and the channel protocol live under
# this namespace. Server time is wall-clock milliseconds, the clock every client offsets itself against.
module Game
  # destruction keys the channel accepts: m:<bag id>, b:<building id>, t/l/g/s:<dm x>,<dm z>, d:<route slot>
  KEY_RE = /\A[mbtlgsd]:[\w,.-]{1,40}\z/

  def self.now_ms = (Time.now.to_f * 1000).to_i

  # Key of a point object (tree, lamp post, traffic light, sign) from its game coordinates. Tiles round these to
  # 0.1 m, so decimetre integers make the client (Math.round(x * 10)) and the server agree exactly.
  def self.point_key(prefix, gx, gz) = "#{prefix}:#{(gx.round(1) * 10).round},#{(gz.round(1) * 10).round}"
end
