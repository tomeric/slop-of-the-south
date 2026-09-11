# BGT road surfaces (wegdeel and ondersteunend wegdeel). The roads themselves are drawn from the OSM centrelines, so
# only the green verges are read: the strips of grass beside a road that the land cover layer leaves out.
class RoadSurface < ApplicationRecord
  VERGE_SQL = "function = 'berm' AND material = 'groenvoorziening'"

  validates :source_id, :layer, :geom, presence: true

  # Verges clipped to the tile, shaped like LandCover.in_tile so the tile builder can paint them with the vegetation.
  def self.verges_in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    rows = connection.select_values(<<~SQL)
      SELECT ST_AsGeoJSON(g, 1) FROM (
        SELECT ST_Multi(ST_CollectionExtract(ST_SimplifyPreserveTopology(ST_Intersection(geom, #{env}), 0.4), 3)) AS g
        FROM road_surfaces
        WHERE #{VERGE_SQL} AND geom && #{env} AND ST_Intersects(geom, #{env})
      ) clipped
      WHERE ST_Area(g) >= #{LandCover::MIN_AREA}
    SQL
    rows.filter_map do |geojson|
      polys = geojson && JSON.parse(geojson)["coordinates"]
      next if polys.blank?
      [ LandCover::VERGE, polys, nil, 0 ]
    end
  end
end
