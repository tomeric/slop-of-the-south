require "test_helper"

module Game
  class RoundManagerTest < ActiveSupport::TestCase
    T = 1_700_000_000_000
    INTERMISSION_AT = T + RoundManager::VOTE_MS
    RUNNING_AT = INTERMISSION_AT + RoundManager::INTERMISSION_MS

    setup do
      @sent = []
      @m = RoundManager.new("test", arena: FakeArena.new, publish: ->(p) { @sent << p }, threaded: false)
    end

    test "runs idle → vote → intermission → running → lost → ended → next vote" do
      assert_nil @m.join("p1", "Piet", T)[:round]
      @m.tick(T)
      assert_equal [ "vote", 4 ], [ @sent.last[:type], @m.vote[:candidates].size ]
      @m.tick(INTERMISSION_AT)
      assert_equal [ :intermission, "round", nil ], [ @m.round.status, @sent.last[:type], @m.vote ]
      @m.tick(RUNNING_AT)
      assert_equal :running, @m.round.status
      lost_at = RUNNING_AT + (250 / @m.round.speed * 1000).ceil + 1
      @m.tick(lost_at - 1000)
      assert_equal :running, @m.round.status
      @m.tick(lost_at)
      assert_equal :ended, @m.round.status
      ended = @sent.find { _1[:type] == "end" }
      assert_equal [ :lost, "m:1" ], [ ended[:result], ended[:key] ]
      @m.tick(lost_at + RoundManager::ENDED_MS)
      assert_equal [ :ended, "vote" ], [ @m.round.status, @sent.last[:type] ]
      @m.tick(lost_at + RoundManager::ENDED_MS + RoundManager::VOTE_MS)
      assert_equal [ :intermission, 2 ], [ @m.round.status, @m.round.id ]
    end

    test "the vote picks the next town, typed towns join the list, unknown ones are refused" do
      @m.join("p1", "Piet", T); @m.join("p2", "Sjeng", T)
      @m.tick(T)
      assert_equal "unknown", @m.cast("p1", "Nergenshuizen", T)[1][:reason]
      ok, payload = @m.cast("p1", "elders", T)
      assert ok
      assert_equal %w[Testdorp Bovenaan Onderaan Ergens Elders], payload[:vote][:candidates].map { _1[:name] }
      @m.cast("p2", "ONDERAAN", T)
      @m.cast("p2", "Elders", T)                                  # a change of mind: one vote per player
      assert_equal({ "Elders" => 2 }, @m.vote[:by].values.tally)
      @m.tick(INTERMISSION_AT)
      assert_equal "Elders", @m.round.arena[:name]
      assert_equal "closed", @m.cast("p1", "Elders", INTERMISSION_AT)[1][:reason]
    end

    test "hits count only while running and leave coalesced" do
      @m.join("p1", "Piet", T)
      @m.tick(T)
      @m.tick(INTERMISSION_AT)
      @m.hit("p1", [ [ "m:1", 50, 100 ] ])
      assert_nil @m.round.objects["m:1"].hp
      @m.tick(RUNNING_AT)
      @m.hit("p1", [ [ "m:1", 50, 100 ], [ "m:1", 60, 100 ] ])
      @m.tick(RUNNING_AT + 250)
      assert_equal [ { key: "m:1", hp: 50, max: 100, state: :rubble } ], @sent.last[:list]
    end

    test "teleport and switch share one cooldown, switching is free between rounds" do
      @m.join("p1", "Piet", T)
      @m.tick(T)
      @m.tick(INTERMISSION_AT)
      assert @m.switch("p1", "tank", T).first
      assert_equal [ false, "status" ], @m.teleport("p1", 0, 0, T).then { [ _1[0], _1[1][:reason] ] }
      @m.tick(RUNNING_AT)
      ok, payload = @m.teleport("p1", 0, 0, RUNNING_AT)
      assert_equal [ true, RUNNING_AT + Round::ACTION_MS ], [ ok, payload[:next_action_at] ]
      assert_equal "cooldown", @m.switch("p1", "trike", RUNNING_AT + 1000)[1][:reason]
      assert_equal "bounds", @m.teleport("p1", 9000, 0, RUNNING_AT + Round::ACTION_MS)[1][:reason]
      assert @m.switch("p1", "trike", RUNNING_AT + Round::ACTION_MS).first
      assert_equal "trike", @m.players["p1"].vehicle
    end

    test "counts a player once across tabs and goes idle once everyone has left" do
      2.times { @m.join("p1", "Piet", T) }
      @m.tick(T)
      @m.tick(INTERMISSION_AT)
      @m.leave("p1")
      assert_equal 1, @m.players.size
      @m.leave("p1")
      assert_empty @m.players
      @m.tick(RUNNING_AT)
      @m.tick(RUNNING_AT + 200_000)                     # long past the first obstacle: lost with nobody watching
      assert_equal :ended, @m.round.status
      @m.tick(RUNNING_AT + 200_000 + RoundManager::ENDED_MS)
      assert_nil @m.round
    end
  end
end
