require "net/http"
require "digest"
require "zlib"

# Building models from 3D BAG (3dbag.nl, TU Delft, CC BY 4.0): LoD1.3 footprints, i.e. every building split into
# parts with their own measured roof height, plus the ground level at the building. Replaces OSM footprints.
namespace :bag3d do
  BAG3D_VERSION = ENV.fetch("BAG3D_VERSION", "v20250903")
  BAG3D_URL     = "https://data.3dbag.nl/#{BAG3D_VERSION}"
  BAG3D_DIR     = Rails.root.join("data", "bag3d")
  BAG3D_TILES   = BAG3D_DIR.join("tiles")

  # RD envelope of World.bbox (phase-1 box, or the full area with WORLD_BBOX=full)
  BAG3D_EXTENT = lambda do
    s, w, n, e = World.bbox
    row = ActiveRecord::Base.connection.select_one(<<~SQL)
      SELECT ST_XMin(g) x0, ST_YMin(g) y0, ST_XMax(g) x1, ST_YMax(g) y1
      FROM (SELECT ST_Transform(ST_MakeEnvelope(#{w}, #{s}, #{e}, #{n}, 4326), 28992) AS g) t
    SQL
    row.values_at("x0", "y0", "x1", "y1").map(&:to_f)
  end

  # Streams a URL to path (via a .part file so an interrupted download never looks complete).
  BAG3D_DOWNLOAD = lambda do |url, path|
    uri = URI(url)
    part = path.sub_ext(".part")
    Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 20, read_timeout: 300) do |http|
      http.request_get(uri.request_uri) do |res|
        raise "#{url}: HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)
        File.open(part, "wb") { |f| res.read_body { |chunk| f.write(chunk) } }
      end
    end
    part.rename(path)
  end

  # PG connection string for ogr2ogr, from database.yml
  BAG3D_PG = lambda do
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    parts = { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }
    "PG:" + parts.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
  end

  desc "Download the 3D BAG GeoPackage tiles covering World.bbox into data/bag3d/tiles (WORLD_BBOX=full for the whole area)"
  task fetch: :environment do
    FileUtils.mkdir_p(BAG3D_TILES)
    index = BAG3D_DIR.join("tile_index.fgb")
    unless index.exist?
      puts "Downloading tile index"
      BAG3D_DOWNLOAD.call("#{BAG3D_URL}/tile_index.fgb", index)
    end
    x0, y0, x1, y1 = BAG3D_EXTENT.call
    geojson = `ogr2ogr -f GeoJSON /vsistdout/ #{index} -spat #{x0} #{y0} #{x1} #{y1} -select tile_id,gpkg_download,gpkg_sha256 -lco WRITE_BBOX=NO`
    raise "ogr2ogr failed; is GDAL installed? (brew install gdal)" unless $?.success?
    tiles = JSON.parse(geojson)["features"].map { |f| f["properties"] }.sort_by { |t| t["tile_id"] }
    puts "#{tiles.size} tiles cover RD #{[ x0, y0, x1, y1 ].map(&:round).join(',')}"

    tiles.each_with_index do |t, i|
      gz   = BAG3D_TILES.join(File.basename(t["gpkg_download"]))
      gpkg = gz.sub_ext("")
      next if gpkg.exist?
      unless gz.exist? && Digest::SHA256.file(gz).hexdigest == t["gpkg_sha256"]
        puts "#{i + 1}/#{tiles.size} #{t["tile_id"]}"
        BAG3D_DOWNLOAD.call(t["gpkg_download"], gz)
        raise "checksum mismatch for #{gz}" unless Digest::SHA256.file(gz).hexdigest == t["gpkg_sha256"]
      end
      Zlib::GzipReader.open(gz) { |r| File.open(gpkg, "wb") { |f| IO.copy_stream(r, f) } }
      gz.delete
    end
    puts "Done → #{BAG3D_TILES}"
  end

  desc "Import data/bag3d/tiles/*.gpkg into PostGIS: LoD1.3 parts → buildings (source 'bag3d'), LoD2.2 surfaces → building_meshes"
  task import: :environment do
    conn = ActiveRecord::Base.connection
    pg = BAG3D_PG.call
    files = Dir[BAG3D_TILES.join("*.gpkg").to_s].sort
    raise "no tiles in #{BAG3D_TILES}; run bin/rails bag3d:fetch first" if files.empty?

    # 1. ogr2ogr every tile into two staging tables (first tile creates them, the rest append)
    files.each_with_index do |file, i|
      mode = i.zero? ? "-overwrite" : "-append"
      print "\r#{i + 1}/#{files.size} #{File.basename(file)}   "
      # (-sql rather than -select: ogr2ogr refuses -select together with -append)
      sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, file, mode, "-nln", "bag3d_lod13_2d", "-t_srs", "EPSG:28992",
         "-lco", "GEOMETRY_NAME=geom", "-sql", "SELECT identificatie, b3_dd_id, b3_pand_deel_id, b3_h_70p, geom FROM lod13_2d", verbose: false
      sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, file, mode, "-nln", "bag3d_pand", "-nlt", "NONE",
         "-sql", "SELECT identificatie, b3_h_maaiveld, b3_dak_type, b3_bouwlagen, oorspronkelijkbouwjaar, status FROM pand", verbose: false
      # -a_srs, not -t_srs: reprojecting out of the compound RD+NAP CRS (EPSG:7415) zeroes the Z coordinates
      # (no -nlt/-dim either: forcing MULTIPOLYGON flattens the Z away; the layer already is MultiPolygon Z)
      sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, file, mode, "-nln", "bag3d_lod22_3d", "-a_srs", "EPSG:28992",
         "-lco", "GEOMETRY_NAME=geom", "-sql", "SELECT identificatie, labels, geom FROM lod22_3d", verbose: false
    end
    puts

    # 2. merge into buildings: one row per LoD1.3 part, extruded from ground level to the part's 70th-percentile roof height
    # b3_dd_id is not unique within a building, so parts are numbered per building; MakeValid can split an invalid
    # footprint into several polygons, which get a ".n" suffix.
    n = conn.exec_update(<<~SQL)
      WITH parts AS (
        SELECT identificatie, b3_h_70p, geom,
               row_number() OVER (PARTITION BY identificatie
                                  ORDER BY b3_dd_id, b3_pand_deel_id, ST_XMin(geom), ST_YMin(geom), b3_h_70p) AS part_no
        FROM bag3d_lod13_2d
        WHERE b3_h_70p IS NOT NULL
      )
      INSERT INTO buildings (source, source_id, height, levels, ground_height, roof_height, roof_type, year, geom, created_at, updated_at)
      SELECT 'bag3d',
             l.identificatie || '/' || l.part_no || CASE WHEN d.path[1] > 1 THEN '.' || d.path[1] ELSE '' END,
             GREATEST(l.b3_h_70p - p.b3_h_maaiveld, 2.5), NULLIF(round(p.b3_bouwlagen), 0)::int,
             p.b3_h_maaiveld, l.b3_h_70p, p.b3_dak_type, NULLIF(round(p.oorspronkelijkbouwjaar), 0)::int,
             d.geom, now(), now()
      FROM parts l
      JOIN bag3d_pand p ON p.identificatie = l.identificatie AND p.b3_h_maaiveld IS NOT NULL,
      LATERAL ST_Dump(ST_CollectionExtract(ST_MakeValid(ST_Force2D(l.geom)), 3)) AS d
      WHERE ST_Area(d.geom) > 0.5
      ON CONFLICT (source, source_id) DO UPDATE SET height = EXCLUDED.height, levels = EXCLUDED.levels,
        ground_height = EXCLUDED.ground_height, roof_height = EXCLUDED.roof_height, roof_type = EXCLUDED.roof_type,
        year = EXCLUDED.year, geom = EXCLUDED.geom, updated_at = now()
    SQL
    # 3. LoD2.2 surfaces (roof planes + walls) per building; labels "(n:0,2,2,1)" → int[] with 0 ground, 1 roof, 2 wall
    m = conn.exec_update(<<~'SQL')   # single-quoted heredoc: keeps the regex backslashes
      INSERT INTO building_meshes (bag_id, roof_type, ground_height, levels, labels, center, geom, created_at, updated_at)
      SELECT DISTINCT ON (s.identificatie) s.identificatie, p.b3_dak_type, p.b3_h_maaiveld,
             NULLIF(round(p.b3_bouwlagen), 0)::int,
             string_to_array(regexp_replace(s.labels, '^\(\d+:|\)$', '', 'g'), ',')::int[],
             ST_Centroid(ST_Force2D(s.geom)), s.geom, now(), now()
      FROM bag3d_lod22_3d s
      LEFT JOIN bag3d_pand p ON p.identificatie = s.identificatie
      WHERE ST_NumGeometries(s.geom) > 0
      ORDER BY s.identificatie
      ON CONFLICT (bag_id) DO UPDATE SET roof_type = EXCLUDED.roof_type, ground_height = EXCLUDED.ground_height,
        levels = EXCLUDED.levels, labels = EXCLUDED.labels, center = EXCLUDED.center, geom = EXCLUDED.geom,
        updated_at = now()
    SQL
    conn.execute("DROP TABLE bag3d_lod13_2d, bag3d_pand, bag3d_lod22_3d")
    puts "Upserted #{n} LoD1.3 parts and #{m} LoD2.2 meshes from #{files.size} tiles; buildings now: bag3d=#{Building.where(source: 'bag3d').count} osm=#{Building.where(source: 'osm').count}, meshes=#{BuildingMesh.count}"
  end

  # Backfill one pand attribute onto meshes that are already imported. `import` would do it too, but it re-reads
  # 13 GB of LoD2.2 geometry to rewrite one integer; the pand layer is attributes only, so this is minutes.
  desc "Backfill building_meshes.levels (b3_bouwlagen) from the downloaded tiles, without touching the geometry"
  task levels: :environment do
    conn = ActiveRecord::Base.connection
    pg = BAG3D_PG.call
    files = Dir[BAG3D_TILES.join("*.gpkg").to_s].sort
    raise "no tiles in #{BAG3D_TILES}; run bin/rails bag3d:fetch first" if files.empty?
    files.each_with_index do |file, i|
      print "\r#{i + 1}/#{files.size} #{File.basename(file)}   "
      sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, file, (i.zero? ? "-overwrite" : "-append"), "-nln", "bag3d_pand",
         "-nlt", "NONE", "-sql", "SELECT identificatie, b3_bouwlagen FROM pand", verbose: false
    end
    puts
    n = conn.exec_update(<<~SQL)
      UPDATE building_meshes m SET levels = NULLIF(round(p.b3_bouwlagen), 0)::int, updated_at = now()
      FROM bag3d_pand p WHERE p.identificatie = m.bag_id
        AND m.levels IS DISTINCT FROM NULLIF(round(p.b3_bouwlagen), 0)::int
    SQL
    conn.execute("DROP TABLE bag3d_pand")
    puts "Set levels on #{n} of #{BuildingMesh.count} meshes; #{BuildingMesh.where(levels: nil).count} still without one"
  end

  desc "Delete downloaded 3D BAG tiles and index"
  task clean: :environment do
    FileUtils.rm_rf(BAG3D_DIR)
  end
end
