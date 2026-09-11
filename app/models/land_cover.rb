# BGT land cover polygons. Kinds map to small codes shared with the client (game/Cover.js), grouped into biomes.
class LandCover < ApplicationRecord
  LAYERS = %w[begroeid onbegroeid water].freeze

  # kind → code painted by the client; unknown kinds are skipped
  CODES = {
    "grasland agrarisch" => 1, "grasland overig" => 2, "groenvoorziening" => 3, "bouwland" => 4, "fruitteelt" => 5,
    "boomteelt" => 6, "loofbos" => 7, "heide" => 8, "struiken" => 9, "rietland" => 10, "zand" => 11,
    "transitie" => 12, "naaldbos" => 13, "gemengd bos" => 14, "houtwal" => 15, "moeras" => 16, "kwelder" => 17,
    "duin" => 18, "haag" => 19,
    "erf" => 20, "gesloten verharding" => 21, "open verharding" => 22, "half verhard" => 23, "onverhard" => 24,
    "berm" => 25, "water" => 30
  }.freeze
  WOOD = [ 7, 13, 14, 15 ].freeze     # every kind of wood, for the biome
  HEDGE = 19                          # BGT vegetatieobject haag, buffered into a strip
  VERGE = 25                          # the green berm along a road (RoadSurface)
  MIN_AREA = 6                        # m²: below this a clipped polygon is smaller than a texel of the cover canvas
  # paint order: vegetation and verges first, then hard surfaces, hedges over both (they lie on the partition), water on top
  ORDER = ->(code) { code == 30 ? 3 : code == HEDGE ? 2 : code.between?(20, 24) ? 1 : 0 }

  # plus-fysiekVoorkomen, the sub-kind BGT records for part of the terrain: small codes the client paints with
  # (game/Cover.js SUB). Anything not listed is 0, and most defaults have to look right on their own: only a third
  # of the begroeid and a fifth of the onbegroeid features carry one.
  DETAILS = {
    "gras- en kruidachtigen" => 1,
    "heesters" => 2, "struikrozen" => 2,
    "bodembedekkers" => 3, "planten" => 3,
    "bosplantsoen" => 4, "griend en hakhout" => 4,
    "akkerbouw" => 5, "vollegrondsteelt" => 5,
    "hoogstam boomgaarden" => 6, "laagstam boomgaarden" => 7,
    "betonstraatstenen" => 8, "gebakken klinkers" => 8, "sierbestrating" => 8,
    "tegels" => 9, "beton element" => 9,
    "asfalt" => 10, "cementbeton" => 10,
    "grind" => 11, "gravel" => 11, "schelpen" => 11, "puin" => 11,
    "zand" => 12, "zandverstuiving" => 12,
    "grasklinkers" => 13,
    "boomschors" => 14
  }.freeze

  # Water that gets a flat surface at its own level and a hollowed bed: lakes, harbours, rivers, canals and the wider
  # watercourses (the Maas is a "waterloop"). Ditches and brooks stay draped on the terrain.
  FLAT_WATER_SQL = "(layer = 'water' AND (kind IN ('watervlakte', 'meer, plas, ven, vijver', 'rivier', 'kanaal', 'haven', 'gracht', 'zee') OR (kind = 'waterloop' AND ST_Area(geom) > 3000)))"
  # how deep the bed goes (metres) — the AHN height inside water is the surface, so the bed has to be carved
  DEPTH = { "rivier" => 6.0, "kanaal" => 5.0, "haven" => 5.0, "zee" => 6.0, "waterloop" => 4.0, "watervlakte" => 3.0, "meer, plas, ven, vijver" => 3.0, "gracht" => 2.5 }.freeze
  BANK_SLOPE = 0.6      # metres of depth per metre from the shore

  validates :source_id, :kind, :geom, presence: true
  validates :layer, inclusion: { in: LAYERS }

  # Polygons clipped to the tile and simplified, as [code, GeoJSON MultiPolygon coordinates, water, sub-code] in RD.
  # Slivers under MIN_AREA are dropped: a village tile is more than half polygons too small to see.
  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    rows = connection.select_rows(<<~SQL)
      SELECT layer, kind, id, flat, detail, ST_AsGeoJSON(g, 1) FROM (
        SELECT layer, kind, id, detail, #{FLAT_WATER_SQL} AS flat,
               ST_Multi(ST_CollectionExtract(ST_SimplifyPreserveTopology(ST_Intersection(geom, #{env}), 0.4), 3)) AS g
        FROM land_covers
        WHERE geom && #{env} AND ST_Intersects(geom, #{env})
      ) clipped
      WHERE ST_Area(g) >= #{MIN_AREA}
    SQL
    rows.filter_map do |layer, kind, id, flat, detail, geojson|
      code = CODES[layer == "water" ? "water" : kind]
      next unless code && geojson
      polys = JSON.parse(geojson)["coordinates"]
      next if polys.blank?
      [ code, polys, layer == "water" ? { id: id, kind: kind, flat: flat } : nil, DETAILS[detail] || 0 ]
    end.sort_by { |code, _| [ ORDER.call(code), code ] }
  end

  # Area shares per code inside the tile (0..1), plus the 3D BAG building footprint share.
  def self.shares_in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    area = World::TILE_SIZE.to_f**2
    shares = Hash.new(0.0)
    connection.select_rows(<<~SQL).each { |layer, kind, a| code = CODES[layer == "water" ? "water" : kind] and shares[code] += a.to_f / area }
      SELECT layer, kind, sum(ST_Area(ST_Intersection(geom, #{env}))) FROM land_covers
      WHERE geom && #{env} AND ST_Intersects(geom, #{env}) GROUP BY layer, kind
    SQL
    shares[:buildings] = connection.select_value(<<~SQL).to_f / area
      SELECT coalesce(sum(ST_Area(ST_Intersection(geom, #{env}))), 0) FROM buildings
      WHERE source = 'bag3d' AND geom && #{env} AND ST_Intersects(geom, #{env})
    SQL
    shares
  end

  # Biome label for a tile from its area shares (Dutch, shown in the HUD). Building footprint share is the urban
  # signal: dense cores and industry >= 25 %, residential 10-25 %, villages 4-10 %; yards (erf) surround every
  # house in town, so they are not counted. Below that the largest rural cover wins.
  def self.biome(shares)
    water   = shares[30]
    bld     = shares[:buildings]
    wood    = WOOD.sum { shares[_1] }
    field   = shares[4] + shares[6]
    orchard = shares[5]
    meadow  = shares[1] + shares[2]
    return "water"       if water >= 0.5
    return "stad"        if bld >= 0.25
    return "woonwijk"    if bld >= 0.10
    return "bos"         if wood >= 0.35
    return "boomgaarden" if orchard >= 0.12
    return "akkerland"   if field >= 0.40 && field >= meadow
    return "weiland"     if meadow >= 0.35
    return "dorp"        if bld >= 0.04
    return "akkerland"   if field >= 0.25 && field >= meadow
    return "weiland"     if meadow >= 0.2
    return "bos"         if wood >= 0.2
    "platteland"
  end
end
