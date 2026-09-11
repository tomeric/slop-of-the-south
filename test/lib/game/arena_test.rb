require "test_helper"

module Game
  class ArenaTest < ActiveSupport::TestCase
    test "paths run through the centre and end on the arena square" do
      arena = Arena.new
      [ 0, Math::PI / 4, Math::PI / 2, 2.5 ].each do |heading|
        p = arena.path_for(100, -200, heading)
        [ [ p[:x0], p[:z0] ], [ p[:x1], p[:z1] ] ].each { |x, z| assert_in_delta 1250, [ (x - 100).abs, (z + 200).abs ].max, 0.1 }
        assert_in_delta Math.hypot(p[:x1] - p[:x0], p[:z1] - p[:z0]), p[:length], 0.2
        assert p[:length].between?(2500, 3536)
      end
    end

    test "a route can be started earlier along its own line" do
      path = Arena.new.path_for(0, 0, Math::PI / 2)                   # due east: from (-1250, 0) to (1250, 0)
      longer = Arena.new.extend_start(path, 100)
      assert_equal [ -1350.0, 0.0, 1250.0, 0.0, 2600.0 ], longer.values_at(:x0, :z0, :x1, :z1, :length)
    end

    test "compass headings become yaws in (-π, π]" do
      arena = Arena.new
      assert_in_delta 0, arena.send(:yaw, 0), 0.001
      assert_in_delta(-Math::PI / 2, arena.send(:yaw, Math::PI / 2), 0.001)
      assert_in_delta Math::PI / 2, arena.send(:yaw, 3 * Math::PI / 2), 0.001
      assert_in_delta(-0.611, arena.send(:yaw, 0.611), 0.001)
    end

    test "point keys match the decimetre rounding of the tiles" do
      assert_equal "t:12937,-140690", Game.point_key("t", 1293.7, -14069.04)
      assert_equal "l:-5,0", Game.point_key("l", -0.46, 0.04)
    end
  end
end
