# A fixed arena for the round tests: a 2.5 km straight path with a building 250 m in and a tree halfway. Four
# towns to vote on; only "Elders" can be typed in on top of them.
class FakeArena
  TOWNS = %w[Testdorp Bovenaan Onderaan Ergens].map { { name: _1, kind: "village", cx: 0.0, cz: 0.0 } }

  def candidates(n) = TOWNS.first(n)
  def find_place(name) = name.casecmp?("Elders") ? { name: "Elders", kind: "village", cx: 0.0, cz: 0.0 } : nil

  def prepare(place: nil, tries: 5)
    { arena: (place || TOWNS.first).merge(half: 1250.0),
      path: { x0: -1250.0, z0: 0.0, x1: 1250.0, z1: 0.0, length: 2500.0 },
      spawn: { x: -1200.0, z: 0.0, yaw: 0.0 },
      obstacles: [ { key: "m:1", kind: "m", x: -1000.0, z: 0.0, at: 250.0 }, { key: "t:1,1", kind: "t", x: 0.0, z: 0.0, at: 1250.0 } ] }
  end
end
