require "test_helper"

# PostGIS-backed: the clipping, the sliver filter and the paint order all live in SQL.
class LandCoverTest < ActiveSupport::TestCase
  TX, TY = 370, 652
  X0, Y0 = TX * World::TILE_SIZE, TY * World::TILE_SIZE

  def square(dx, dy, size, x0: X0, y0: Y0)
    x, y = x0 + dx, y0 + dy
    "POLYGON((#{x} #{y}, #{x + size} #{y}, #{x + size} #{y + size}, #{x} #{y + size}, #{x} #{y}))"
  end

  def insert(source_id, kind, wkt, layer: "begroeid", detail: nil)
    LandCover.connection.execute(<<~SQL)
      INSERT INTO land_covers (source_id, layer, kind, detail, geom, created_at, updated_at)
      VALUES (#{LandCover.connection.quote(source_id)}, '#{layer}', '#{kind}', #{LandCover.connection.quote(detail)},
              ST_Multi(ST_GeomFromText('#{wkt}', 28992)), now(), now())
    SQL
  end

  test "every wood kind has its own code and they are all wood" do
    assert_equal [ "gemengd bos", "houtwal", "loofbos", "naaldbos" ].sort, LandCover::CODES.select { |_, c| LandCover::WOOD.include?(c) }.keys.sort
    assert_equal LandCover::WOOD.uniq.size, LandCover::WOOD.size
    assert_equal LandCover::CODES.values.uniq.size, LandCover::CODES.values.size, "two kinds share a code"
  end

  test "paint order puts vegetation and verges under pavement, hedges over both and water on top" do
    order = LandCover::ORDER
    assert_equal 0, order.call(1)
    assert_equal 0, order.call(LandCover::VERGE)
    assert_equal 1, order.call(21)
    assert_equal 2, order.call(LandCover::HEDGE)
    assert_equal 3, order.call(30)
  end

  test "a tile of conifers and mixed wood is still a bos" do
    shares = Hash.new(0.0).merge(13 => 0.2, 14 => 0.1, 15 => 0.06, :buildings => 0.0)
    assert_equal "bos", LandCover.biome(shares)
  end

  test "in_tile drops slivers, keeps the sub-kind and sorts the hedge over the pavement" do
    insert("test-gras", "grasland overig", square(100, 100, 60), detail: "gras- en kruidachtigen")
    insert("test-heesters", "groenvoorziening", square(200, 100, 30), detail: "heesters")
    insert("test-sliver", "grasland overig", square(10, 10, 2))
    insert("test-klinker", "open verharding", square(300, 100, 40), layer: "onbegroeid")
    insert("test-haag", "haag", square(300, 110, 20))
    insert("test-water", "waterloop", square(400, 100, 40), layer: "water")

    rows = LandCover.in_tile(TX, TY).reject { |_, _, _, _| false }
    codes = rows.map(&:first)
    assert_equal [ 2, 3, 22, LandCover::HEDGE, 30 ], codes, "sliver dropped, hedge over the pavement, water last"
    assert_equal [ 1, 2, 0, 0, 0 ], rows.map(&:last), "sub-kinds come through"
    assert rows.last[2], "water carries its own row"
  end

  test "shares_in_tile counts what in_tile leaves out" do
    insert("test-sliver", "grasland overig", square(10, 10, 2))
    assert_equal [], LandCover.in_tile(TX, TY)
    assert_in_delta 4.0 / World::TILE_SIZE**2, LandCover.shares_in_tile(TX, TY)[2], 1e-9
  end
end
