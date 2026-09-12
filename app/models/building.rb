class Building < ApplicationRecord
  SOURCES = %w[bag3d osm].freeze

  validates :source, inclusion: { in: SOURCES }
  validates :source_id, :geom, presence: true

  # Buildings whose centroid falls inside the tile, so each building is emitted exactly once.
  # 3D BAG wins; OSM buildings are only used where no 3D BAG building overlaps them (i.e. outside the Netherlands).
  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    connection.select_all(<<~SQL).map { |r| r.merge("geojson" => JSON.parse(r["geojson"])) }
      SELECT id, source, source_id, height, kind, roof_type, ground_height, roof_height, woz, ST_AsGeoJSON(geom, 2) AS geojson
      FROM buildings b
      WHERE geom && #{env} AND ST_Intersects(ST_Centroid(geom), #{env})   -- && first: uses the GiST index
        AND (source <> 'osm' OR NOT EXISTS (
              SELECT 1 FROM buildings o WHERE o.source = 'bag3d' AND o.geom && b.geom AND ST_Intersects(o.geom, b.geom)))
    SQL
  end
end
