require "test_helper"

# The cover half of a tile: polygons, their sub-kinds and the verges, all in decimetres from the tile corner.
class TileBuilderTest < ActiveSupport::TestCase
  TX, TY = 371, 653
  X0, Y0 = TX * World::TILE_SIZE, TY * World::TILE_SIZE

  def square(dx, dy, size)
    x, y = X0 + dx, Y0 + dy
    "POLYGON((#{x} #{y}, #{x + size} #{y}, #{x + size} #{y + size}, #{x} #{y + size}, #{x} #{y}))"
  end

  def builder = TileBuilder.new(heights: Geo::HeightGrid::Flat.new)

  test "cover_for returns rings in decimetres with one sub-kind each, verges included" do
    LandCover.connection.execute(<<~SQL)
      INSERT INTO land_covers (source_id, layer, kind, detail, geom, created_at, updated_at)
      VALUES ('tb-gras', 'begroeid', 'groenvoorziening', 'bosplantsoen', ST_Multi(ST_GeomFromText('#{square(100, 100, 50)}', 28992)), now(), now())
    SQL
    RoadSurface.connection.execute(<<~SQL)
      INSERT INTO road_surfaces (source_id, layer, function, material, geom, created_at, updated_at)
      VALUES ('tb-berm', 'ondersteunend', 'berm', 'groenvoorziening', ST_Multi(ST_GeomFromText('#{square(200, 100, 20)}', 28992)), now(), now())
    SQL

    cover, sub = builder.send(:cover_for, TX, TY, X0, Y0 + World::TILE_SIZE)
    assert_equal cover.size, sub.size
    assert_equal [ 3, LandCover::VERGE ], cover.map(&:first)
    assert_equal [ 4, 0 ], sub
    rings = cover.first[1]
    assert_equal 0, rings.size % 2
    assert rings.all? { _1.between?(0, 5000) }, "rings are decimetres inside the tile"
    assert_equal 3500, rings.each_slice(2).map(&:last).min, "100 m from the north edge, 350 dm down"
  end
end
