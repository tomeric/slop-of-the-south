# BGT road surfaces (wegdeel and ondersteunend wegdeel): the surveyed outline of every carriageway, cycle path,
# footway, parking bay, driveway and traffic island. The roads themselves still come from the OSM centrelines —
# those carry the height, the name, the lanes and the junctions — but what is *drawn* on the ground is this.
#
# BGT is a planar partition, so the polygons of a tile are simplified as one coverage before anything is merged:
# neighbours keep their shared edges to the millimetre and no green cracks open between a carriageway and the
# footway beside it. They are then unioned per class and material, which is what turns four approach legs into one
# junction with real flares without a line of junction code anywhere.
class RoadSurface < ApplicationRecord
  MIN_AREA = 3.0        # m²: smaller than land cover's, because a traffic island has a median area of 10 m²
  SIMPLIFY = 0.5        # m: the coverage tolerance, and the size/quality knob for the whole surface layer

  # bgt-functie → the class the client draws. VERGE is the odd one out: it is green, so the tile builder paints it
  # with the land cover instead of drawing it as a surface.
  ROAD = 0
  CYCLE = 1
  FOOT = 2
  PARKING = 3
  DRIVEWAY = 4
  ISLAND = 5
  VERGE = 9
  CLASSES = {
    "rijbaan lokale weg" => ROAD, "rijbaan regionale weg" => ROAD, "rijbaan autosnelweg" => ROAD, "rijbaan autoweg" => ROAD,
    "fietspad" => CYCLE,
    "voetpad" => FOOT, "voetpad op trap" => FOOT, "voetgangersgebied" => FOOT, "ruiterpad" => FOOT,
    "parkeervlak" => PARKING, "inrit" => DRIVEWAY,
    "verkeerseiland" => ISLAND, "transitie" => ISLAND, "OV-baan" => ISLAND,
    "berm" => VERGE
  }.freeze
  # bgt-fysiekVoorkomen → the surface it is made of; the client picks a texture from (class, material)
  MATERIALS = { "gesloten verharding" => 0, "open verharding" => 1, "half verhard" => 2, "onverhard" => 3, "groenvoorziening" => 4 }.freeze
  DRAWN = (CLASSES.values.uniq - [ VERGE ]).freeze

  validates :source_id, :layer, :geom, presence: true

  # [[class, material, GeoJSON MultiPolygon coordinates], …] for the tile, in RD.
  def self.in_tile(tx, ty)
    rows_in_tile(tx, ty)
  rescue ActiveRecord::StatementInvalid => e
    # ST_CoverageSimplify refuses an invalid coverage (a handful of overlapping polygons province-wide); simplifying
    # each polygon on its own then costs a hairline crack between neighbours, which beats losing the tile
    Rails.logger.warn("road_surfaces: coverage simplify failed for #{tx}_#{ty}: #{e.message.lines.first&.strip}")
    rows_in_tile(tx, ty, coverage: false)
  end

  def self.rows_in_tile(tx, ty, coverage: true)
    env = Road.tile_envelope_sql(tx, ty)
    simplify = coverage ? "ST_CoverageSimplify(g, #{SIMPLIFY}) OVER ()" : "ST_SimplifyPreserveTopology(g, #{SIMPLIFY})"
    rows = connection.select_rows(<<~SQL)
      WITH clipped AS (
        SELECT #{case_sql(CLASSES, 'function')} AS cls, #{case_sql(MATERIALS, 'material')} AS mat,
               ST_CollectionExtract(ST_Intersection(geom, #{env}), 3) AS g
        FROM road_surfaces
        WHERE level = 0 AND geom && #{env} AND ST_Intersects(geom, #{env})
      ), simplified AS (
        -- one coverage, simplified as a whole: shared edges stay shared, so no cracks open between the classes
        SELECT cls, mat, #{simplify} AS g
        FROM clipped WHERE NOT ST_IsEmpty(g)
      ), merged AS (
        SELECT cls, mat, ST_Union(g) AS g FROM simplified WHERE cls IS NOT NULL GROUP BY cls, mat
      )
      SELECT cls, mat, ST_AsGeoJSON(ST_Multi(part.geom), 1)
      FROM merged, LATERAL (SELECT (ST_Dump(g)).geom) part
      WHERE ST_Area(part.geom) >= #{MIN_AREA}
      ORDER BY cls, mat
    SQL
    rows.filter_map do |cls, mat, geojson|
      polys = geojson && JSON.parse(geojson)["coordinates"]
      next if polys.blank?
      [ cls.to_i, mat.to_i, polys ]
    end
  end

  # How much of each road's length BGT actually paves, by road id. Where that is low the surveyed outline is
  # missing or disagrees (the German border strip, a new estate), and the client falls back to its own ribbon.
  def self.paved_fraction(x0, y0, x1, y1)
    env = "ST_MakeEnvelope(#{x0}, #{y0}, #{x1}, #{y1}, 28992)"
    # summed per road rather than unioned first: BGT is a partition, so the pieces of one road do not overlap, and
    # this way every intersection is one indexed lookup instead of a union of thousands of polygons
    connection.select_rows(<<~SQL).to_h { |id, f| [ id.to_i, f.to_f ] }
      SELECT r.id, COALESCE(sum(ST_Length(ST_Intersection(r.geom, s.geom))), 0) / GREATEST(ST_Length(r.geom), 0.01)
      FROM roads r
      LEFT JOIN road_surfaces s
        ON s.level = 0 AND s.function IN (#{CLASSES.reject { |_, v| v == VERGE }.keys.map { connection.quote(_1) }.join(', ')})
       AND s.geom && r.geom AND ST_Intersects(s.geom, r.geom)
      WHERE r.geom && #{env} AND ST_Intersects(r.geom, #{env})
      GROUP BY r.id, r.geom
    SQL
  end

  def self.case_sql(map, column)
    "CASE #{map.map { |k, v| "WHEN #{column} = #{connection.quote(k)} THEN #{v}" }.join(' ')} END"
  end
end
