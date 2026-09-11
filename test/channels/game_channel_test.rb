require "test_helper"

class GameChannelTest < ActionCable::Channel::TestCase
  T = 1_700_000_000_000

  setup do
    @manager = Game::RoundManager.reset!("test", arena: FakeArena.new, publish: ->(_) {}, threaded: false)
    stub_connection(player_id: "p1")
    subscribe room: "test", name: "Pietje"
  end

  teardown { Game::RoundManager.shutdown }

  test "hands the subscriber a sync and announces the join" do
    assert_has_stream "game:test"
    assert_equal [ "sync", "p1" ], [ transmissions.last["type"], transmissions.last["you"]["id"] ]
    assert_equal "join", ActiveSupport::JSON.decode(broadcasts("game:test").last)["type"]
  end

  test "relays moves with the vehicle" do
    perform :move, x: 1, y: 2, z: 3, yaw: 0.5, speed: 10, brake: false, vehicle: "tank"
    move = ActiveSupport::JSON.decode(broadcasts("game:test").last)
    assert_equal [ "move", "tank", "p1", 1.0 ], move.values_at("type", "vehicle", "id", "x")
  end

  test "applies valid hits and drops malformed ones" do
    @manager.tick(T)
    @manager.tick(T + Game::RoundManager::VOTE_MS)
    @manager.tick(T + Game::RoundManager::VOTE_MS + Game::RoundManager::INTERMISSION_MS)
    hits = [ { "key" => "m:1", "damage" => 30, "max" => 100 }, { "key" => "x:1", "damage" => 30, "max" => 100 }, { "key" => "m:2", "damage" => -5, "max" => 100 } ]
    perform :hit, hits: hits
    assert_equal 70, @manager.round.objects["m:1"].hp
    assert_nil @manager.round.objects["x:1"]
    assert_nil @manager.round.objects["m:2"]
  end
end
