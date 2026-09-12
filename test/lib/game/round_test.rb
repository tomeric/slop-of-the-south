require "test_helper"

module Game
  class RoundTest < ActiveSupport::TestCase
    START = 1_700_000_000_000

    def round(obstacles = [ obstacle("m:1", 300), obstacle("t:1,1", 120), obstacle("m:2", 900) ])
      Round.new(id: 1, arena: { cx: 0.0, cz: 0.0, half: 1250.0 }, path: { x0: -1250.0, z0: 0.0, x1: 1250.0, z1: 0.0, length: 2500.0 },
                spawn: { x: 0.0, z: 0.0, yaw: 0.0 }, obstacles:)
    end

    def obstacle(key, at) = { key:, kind: key[0], x: 0.0, z: 0.0, at: at.to_f }

    test "sorts obstacles along the path and blocks on the first one standing" do
      r = round
      assert_equal [ 120, 300, 900 ], r.obstacles.map(&:at)
      r.hit("t:1,1", 1, 1)
      assert_equal "m:1", r.blocker.key
    end

    test "loses when the float reaches a standing obstacle and wins once the path is clear" do
      r = round
      r.start!(START, [])
      before = START + (120 / r.speed * 1000).floor - 1
      assert_nil r.check(before)
      assert_equal :lost, r.check(before + 2)
      assert_in_delta(-1250 + 120, r.float_at(before + 2)[0], 0.01)
      r.obstacles.each { |o| 2.times { r.hit(o.key, 10_000, 100) } }
      assert_nil r.check(START + Round::CROSSING_MS - 1)
      assert_equal :won, r.check(START + Round::CROSSING_MS)
    end

    test "buildings crumble to rubble and then vanish, other things vanish at once" do
      r = round
      assert_equal :intact, r.hit("m:1", 60, 100).state
      rubble = r.hit("m:1", 60, 999)                                  # the second max is ignored
      assert_equal [ :rubble, 50, 100 ], [ rubble.state, rubble.hp, rubble.max ]
      assert_equal :rubble, r.hit("m:1", 49, 100).state
      assert_equal :gone, r.hit("m:1", 1, 100).state
      assert_nil r.hit("m:1", 1, 100)
      assert_equal :gone, r.hit("t:5,5", 30, 30).state
      assert_nil r.hit("l:5,5", -3, 30)
      assert_equal [ "t:5,5" ], r.to_h([]).dig(:objects).map { _1[:key] }
    end

    test "the euro counter bills each intact building once, for what it actually took off" do
      r = round
      r.hit("m:1", 25, 100, 400_000)                                  # a quarter of a four-tonne house
      assert_in_delta 100_000, r.damage, 1
      r.hit("m:1", 75, 100, 9_000_000)                                # the second claim is ignored, like max
      assert_in_delta 400_000, r.damage, 1
      r.hit("m:1", 50, 100, 400_000)                                  # clearing the rubble is free
      assert_in_delta 400_000, r.damage, 1
      r.hit("m:2", 500, 100, 400_000)                                 # one huge hit still bills one house
      assert_in_delta 800_000, r.damage, 1
      r.hit("m:3", 100, 100, 99_999_999)                              # nobody owns a hundred-million-euro house
      assert_in_delta 800_000 + Round::MAX_WOZ, r.damage, 1
      assert_equal 800_000 + Round::MAX_WOZ, r.to_h([])[:damage]
    end

    test "debris in the road becomes something the parade has to get past" do
      r = round
      r.start!(START, [])
      now = START + 10_000
      travelled = r.travelled(now)
      # behind the float, and too close in front of it, are both ignored: the parade is already past or has no chance
      assert_nil r.debris(travelled - 5, now)
      assert_nil r.debris(travelled + Round::DEBRIS_AHEAD - 1, now)
      far = travelled + Round::DEBRIS_AHEAD + 50
      heap = r.debris(far, now)
      assert_equal [ "d", Round::DEBRIS_HP ], [ heap.kind, heap.hp ]
      # a second load in the same stretch of road piles onto the same heap rather than making another
      same = r.debris(far + Round::DEBRIS_SLOT / 4, now)
      assert_equal heap.key, same.key
      assert_equal Round::DEBRIS_HP * 2, same.hp
      # it sits in route order, so the blocker walk finds it in the right place
      assert_equal r.obstacles.map(&:at).sort, r.obstacles.map(&:at)
      # and the float loses to it, until it is swept aside
      at = START + (heap.at / r.speed * 1000).ceil + 10
      assert_equal :lost, r.check(at)
      r.hit(heap.key, 999, heap.max)
      assert_equal :gone, r.objects[heap.key].state
      assert_nil r.check(at)
    end

    test "the shared action waits a minute and is free again when a round starts" do
      r = round
      p = Round::Player.new(id: "p", name: "Piet", joined_at: 0, tabs: 1)
      assert r.action_allowed?(p, START)
      p.last_action_at = START
      assert_not r.action_allowed?(p, START + 59_999)
      assert_equal START + 60_000, r.next_action_at(p)
      assert r.action_allowed?(p, START + 60_000)
      p.last_action_at = START + 60_000
      r.start!(START + 70_000, [ p ])
      assert r.action_allowed?(p, START + 70_000)
    end
  end
end
