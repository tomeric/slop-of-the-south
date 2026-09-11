require "net/http"

# Province-wide BGT through PDOK's bulk download API: one custom extract (GML light) per municipality, requested
# asynchronously, polled, downloaded to data/bgt/bulk/<gemeente>.zip and imported with ogr2ogr.
namespace :bgt do
  BGT_DOWNLOAD = ENV.fetch("BGT_DOWNLOAD_URL", "https://api.pdok.nl/lv/bgt/download/v1_0")
  BULK_DIR     = Rails.root.join("data", "bgt", "bulk")
  BULK_TYPES   = ENV.fetch("BGT_BULK_TYPES", "begroeidterreindeel,onbegroeidterreindeel,waterdeel,vegetatieobject").split(",")

  # Limburg's municipalities (name → RD polygon WKT, simplified and slightly buffered) from PDOK Bestuurlijke Gebieden
  BULK_MUNICIPALITIES = lambda do
    province = ENV.fetch("PROVINCE", "Limburg")
    only = ENV["MUNICIPALITIES"]&.split(",")
    res = Net::HTTP.get_response(URI("https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/gemeentegebied/items?f=json&limit=400&crs=http://www.opengis.net/def/crs/EPSG/0/28992"))
    raise "PDOK #{res.code}" unless res.is_a?(Net::HTTPSuccess)
    conn = ActiveRecord::Base.connection
    JSON.parse(res.body)["features"].filter_map do |f|
      next unless f["properties"]["ligt_in_provincie_naam"] == province
      name = f["properties"]["naam"]
      next if only && !only.include?(name)
      # the download API accepts a single ring only: largest part of the buffered municipality, exterior ring, no holes
      wkt = conn.select_value(<<~SQL)
        SELECT ST_AsText(ST_MakePolygon(ST_ExteriorRing(d.geom)), 0)
        FROM (SELECT (ST_Dump(ST_Buffer(ST_SimplifyPreserveTopology(ST_SetSRID(ST_GeomFromGeoJSON(#{conn.quote(f['geometry'].to_json)}), 28992), 40), 150))).geom) d
        ORDER BY ST_Area(d.geom) DESC LIMIT 1
      SQL
      [ name, wkt ]
    end.sort
  end

  BULK_JSON = lambda do |method, path, body = nil|
    # PDOK returns absolute paths ("/lv/bgt/download/v1_0/...") in _links; relative ones are ours
    uri = URI(path.start_with?("http") ? path : (path.start_with?("/lv/") ? "https://api.pdok.nl#{path}" : "#{BGT_DOWNLOAD}#{path}"))
    req = method == :post ? Net::HTTP::Post.new(uri, "Content-Type" => "application/json", "Accept" => "application/json") : Net::HTTP::Get.new(uri, "Accept" => "application/json")
    req.body = body.to_json if body
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 120) { |http| http.request(req) }
    raise "#{method.upcase} #{uri}: #{res.code} #{res.body.to_s[0, 300]}" unless res.code.to_i.between?(200, 299)
    JSON.parse(res.body)
  end

  desc "Request + download BGT GML-light extracts per municipality (PROVINCE=Limburg, MUNICIPALITIES=a,b to restrict)"
  task bulk_fetch: :environment do
    FileUtils.mkdir_p(BULK_DIR)
    pending = {}
    BULK_MUNICIPALITIES.call.each do |name, wkt|
      # extracts are named by municipality; a non-default type set gets a suffix (e.g. Beek-wegdeel.zip)
      suffix = BULK_TYPES == %w[begroeidterreindeel onbegroeidterreindeel waterdeel vegetatieobject] ? "" : "-#{BULK_TYPES.join('+')}"
      zip = BULK_DIR.join("#{name.tr(' ', '_')}#{suffix}.zip")
      next puts("#{name}: already downloaded") if zip.exist?
      res = BULK_JSON.call(:post, "/full/custom", { featuretypes: BULK_TYPES, format: "gmllight", geofilter: wkt })
      id = res["downloadRequestId"]
      status_path = res.dig("_links", "status", "href") || "/full/custom/#{id}/status"
      pending[name] = { zip: zip, status: status_path }
      puts "#{name}: requested (#{id})"
      sleep 1
    end
    until pending.empty?
      sleep 15
      pending.each do |name, job|
        st = BULK_JSON.call(:get, job[:status])
        case st["status"]
        when "COMPLETED"
          href = st.dig("_links", "download", "href")
          url = href.start_with?("http") ? href : "https://api.pdok.nl#{href}"
          part = job[:zip].sub_ext(".part")
          uri = URI(url)
          Net::HTTP.start(uri.host, uri.port, use_ssl: true, read_timeout: 600) do |http|
            http.request_get(uri.request_uri) do |dl|
              raise "download #{dl.code}" unless dl.is_a?(Net::HTTPSuccess)
              File.open(part, "wb") { |f| dl.read_body { |chunk| f.write(chunk) } }
            end
          end
          part.rename(job[:zip])
          puts "#{name}: downloaded #{(job[:zip].size / 1e6).round(1)} MB"
          pending.delete(name)
        when "FAILED", "ERROR"
          warn "#{name}: #{st.inspect}"
          pending.delete(name)
        else
          print "\r#{name}: #{st['status']} #{st['progress']}%   "
        end
      rescue => e
        warn "#{name}: #{e.message.lines.first}"
      end
    end
    puts "Done → #{BULK_DIR}"
  end
end

namespace :bgt do
  # Import the GML-light extracts: ogr2ogr each municipality's files into staging tables, then rebuild land_covers
  # and the BGT trees from them (the extracts supersede whatever the paged API import loaded for the Mijnstreek).
  desc "Import data/bgt/bulk/*.zip (GML light) into land_covers and trees"
  task bulk_import: :environment do
    conn = ActiveRecord::Base.connection
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    zips = Dir[BULK_DIR.join("*.zip").to_s].sort
    raise "no extracts in #{BULK_DIR}; run bin/rails bgt:bulk_fetch" if zips.empty?

    layers = {
      "bgt_begroeidterreindeel" => [ "BegroeidTerreindeel", %(SELECT gml_id, "bgt-fysiekVoorkomen" AS kind, "plus-fysiekVoorkomen" AS detail, eindRegistratie, objectEindTijd FROM BegroeidTerreindeel), %w[-nlt PROMOTE_TO_MULTI -nlt CONVERT_TO_LINEAR] ],
      "bgt_onbegroeidterreindeel" => [ "OnbegroeidTerreindeel", %(SELECT gml_id, "bgt-fysiekVoorkomen" AS kind, "plus-fysiekVoorkomen" AS detail, eindRegistratie, objectEindTijd FROM OnbegroeidTerreindeel), %w[-nlt PROMOTE_TO_MULTI -nlt CONVERT_TO_LINEAR] ],
      # (OGR SQL has no COALESCE: water keeps both type columns, merged in PostgreSQL below)
      "bgt_waterdeel" => [ "Waterdeel", %(SELECT gml_id, "plus-type" AS plus_type, "bgt-type" AS bgt_type, eindRegistratie, objectEindTijd FROM Waterdeel), %w[-nlt PROMOTE_TO_MULTI -nlt CONVERT_TO_LINEAR] ],
      "bgt_vegetatieobject" => [ "VegetatieObject", %(SELECT gml_id, "plus-type" AS kind, eindRegistratie, objectEindTijd FROM VegetatieObject), %w[-nlt CONVERT_TO_LINEAR] ]
    }
    first = true
    zips.each_with_index do |zip, i|
      dir = Pathname(zip).sub_ext("")
      sh "unzip", "-oq", zip, "-d", dir.to_s, verbose: false unless dir.exist?
      layers.each do |file, (_layer, sql, nlt)|
        gml = dir.join("#{file}.gml")
        next unless gml.exist?
        sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, gml.to_s, (first ? "-overwrite" : "-append"), "-nln", "bulk_#{file}", *nlt,
           "-a_srs", "EPSG:28992", "-lco", "GEOMETRY_NAME=geom", "-sql", sql, "--config", "GML_SKIP_RESOLVE_ELEMS", "ALL", verbose: false
      end
      first = false
      print "\r#{i + 1}/#{zips.size} #{File.basename(zip, '.zip')}   "
    end
    puts

    conn.transaction do
      conn.execute("DELETE FROM land_covers")
      conn.execute("DELETE FROM trees WHERE source = 'bgt'")
      current = "eindregistratie IS NULL AND objecteindtijd IS NULL"
      { "bulk_bgt_begroeidterreindeel" => [ "begroeid", "kind", "detail" ], "bulk_bgt_onbegroeidterreindeel" => [ "onbegroeid", "kind", "detail" ],
        "bulk_bgt_waterdeel" => [ "water", "COALESCE(plus_type, bgt_type)", "NULL" ] }.each do |table, (layer, kind, detail)|
        n = conn.exec_update(<<~SQL)
          INSERT INTO land_covers (source_id, layer, kind, detail, geom, created_at, updated_at)
          SELECT DISTINCT ON (gml_id) gml_id, '#{layer}', #{kind}, #{detail}, ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)), now(), now()
          FROM #{table}
          WHERE #{current} AND #{kind} IS NOT NULL AND #{kind} NOT LIKE 'greppel%' AND NOT ST_IsEmpty(geom)
          ORDER BY gml_id
          ON CONFLICT (source_id) DO UPDATE SET layer = EXCLUDED.layer, kind = EXCLUDED.kind, detail = EXCLUDED.detail, geom = EXCLUDED.geom, updated_at = now()
        SQL
        puts "#{layer}: #{n} polygons"
      end
      # hedges are vegetation objects, not terrain: the lines among them become a one metre strip
      hedges = conn.exec_update(<<~SQL)
        INSERT INTO land_covers (source_id, layer, kind, geom, created_at, updated_at)
        SELECT DISTINCT ON (gml_id) gml_id, 'begroeid', 'haag',
               ST_Multi(ST_CollectionExtract(ST_MakeValid(
                 CASE WHEN ST_Dimension(geom) = 1 THEN ST_Buffer(ST_Force2D(geom), 0.5, 'endcap=flat join=round') ELSE ST_Force2D(geom) END), 3)), now(), now()
        FROM bulk_bgt_vegetatieobject
        WHERE #{current} AND kind = 'haag' AND ST_Dimension(geom) >= 1 AND NOT ST_IsEmpty(geom)
        ORDER BY gml_id
        ON CONFLICT (source_id) DO UPDATE SET layer = EXCLUDED.layer, kind = EXCLUDED.kind, geom = EXCLUDED.geom, updated_at = now()
      SQL
      puts "hedges: #{hedges} strips"
      trees = conn.exec_update(<<~SQL)
        INSERT INTO trees (source, source_id, kind, height, geom, created_at, updated_at)
        SELECT DISTINCT ON (gml_id) 'bgt', gml_id, 'boom', 6 + (('x' || substr(md5(gml_id), 1, 6))::bit(24)::int % 700) / 100.0, ST_Force2D(geom), now(), now()
        FROM bulk_bgt_vegetatieobject
        WHERE #{current} AND kind = 'boom' AND ST_GeometryType(geom) = 'ST_Point'
        ORDER BY gml_id
        ON CONFLICT (source, source_id) DO UPDATE SET height = EXCLUDED.height, geom = EXCLUDED.geom, updated_at = now()
      SQL
      puts "trees: #{trees} registered"
      conn.execute("DROP TABLE " + layers.keys.map { "bulk_#{_1}" }.join(", "))
    end
    BGT_FILL.call(conn, %w[woods orchards]) unless ENV["SKIP_TREE_FILL"]
    puts "land_covers: #{LandCover.group(:layer).count.inspect}; trees: #{Tree.count}"
  end

  # Scatter trees through the woodland and orchard polygons. Split out of the import: it writes eight million rows
  # and only has to run when the land cover itself changed.
  BGT_FILL = lambda do |conn, only|
    if only.include?("woods")
      woods = BGT_WOODS.map { |k, w| "(#{conn.quote(k)}, #{w[:area]}, #{w[:height].min}, #{w[:height].max})" }.join(",")
      conn.execute("DELETE FROM trees WHERE source = 'bgt_bos'")
      n = conn.exec_update(<<~SQL)
        INSERT INTO trees (source, source_id, kind, height, geom, created_at, updated_at)
        SELECT 'bgt_bos', lc.source_id || '/' || d.path[1], lc.kind, w.hmin + (w.hmax - w.hmin) * random(), d.geom, now(), now()
        FROM land_covers lc
        JOIN (VALUES #{woods}) AS w(kind, area, hmin, hmax) ON w.kind = lc.kind,
        LATERAL ST_Dump(ST_GeneratePoints(lc.geom, GREATEST(1, (ST_Area(lc.geom) / w.area)::int), ('x' || substr(md5(lc.source_id), 1, 6))::bit(24)::int)) AS d
        WHERE lc.layer = 'begroeid'
        ON CONFLICT (source, source_id) DO UPDATE SET geom = EXCLUDED.geom, updated_at = now()
      SQL
      puts "trees in woods: #{n}"
    end
    if only.include?("orchards")
      conn.execute("DELETE FROM trees WHERE source = 'bgt_boomgaard'")
      n = conn.exec_update(<<~SQL)
        INSERT INTO trees (source, source_id, kind, height, geom, created_at, updated_at)
        SELECT 'bgt_boomgaard', lc.source_id || '/' || row_number() OVER (PARTITION BY lc.source_id ORDER BY ST_X(p), ST_Y(p)), 'fruitteelt', 4.5 + 2 * random(), p, now(), now()
        FROM land_covers lc, LATERAL (SELECT ST_Centroid(c.geom) AS p FROM ST_SquareGrid(9, lc.geom) AS c WHERE ST_Within(ST_Centroid(c.geom), lc.geom)) g
        WHERE lc.layer = 'begroeid' AND lc.kind = 'fruitteelt'
        ON CONFLICT (source, source_id) DO UPDATE SET geom = EXCLUDED.geom, updated_at = now()
      SQL
      puts "trees in orchards: #{n}"
    end
  end

  desc "Scatter trees into the BGT woods and orchards already in land_covers (ONLY=woods,orchards)"
  task tree_fill: :environment do
    BGT_FILL.call(ActiveRecord::Base.connection, ENV.fetch("ONLY", "woods,orchards").split(","))
    puts "trees: #{Tree.count}"
  end
end

namespace :bgt do
  # Import the wegdeel extracts (bgt:bulk_fetch with BGT_BULK_TYPES=wegdeel,ondersteunendwegdeel) into road_surfaces.
  desc "Import data/bgt/bulk/*-wegdeel+ondersteunendwegdeel.zip into road_surfaces"
  task wegdeel_import: :environment do
    conn = ActiveRecord::Base.connection
    c = ActiveRecord::Base.connection_db_config.configuration_hash
    pg = "PG:" + { dbname: c[:database], host: c[:host], port: c[:port], user: c[:username], password: c[:password] }.compact.map { |k, v| "#{k}=#{v}" }.join(" ")
    zips = Dir[BULK_DIR.join("*-wegdeel+ondersteunendwegdeel.zip").to_s].sort
    raise "no wegdeel extracts; run BGT_BULK_TYPES=wegdeel,ondersteunendwegdeel bin/rails bgt:bulk_fetch" if zips.empty?
    layers = {
      "bgt_wegdeel" => %(SELECT gml_id, "bgt-functie" AS function, "bgt-fysiekVoorkomen" AS material, eindRegistratie, objectEindTijd FROM Wegdeel),
      "bgt_ondersteunendwegdeel" => %(SELECT gml_id, "bgt-functie" AS function, "bgt-fysiekVoorkomen" AS material, eindRegistratie, objectEindTijd FROM OndersteunendWegdeel)
    }
    first = true
    zips.each_with_index do |zip, i|
      dir = Pathname(zip).sub_ext("")
      sh "unzip", "-oq", zip, "-d", dir.to_s, verbose: false unless dir.exist?
      layers.each do |file, sql|
        gml = dir.join("#{file}.gml")
        next unless gml.exist?
        sh "ogr2ogr", "-q", "-f", "PostgreSQL", pg, gml.to_s, (first ? "-overwrite" : "-append"), "-nln", "bulk_#{file}",
           "-nlt", "PROMOTE_TO_MULTI", "-nlt", "CONVERT_TO_LINEAR", "-a_srs", "EPSG:28992", "-lco", "GEOMETRY_NAME=geom",
           "-sql", sql, "--config", "GML_SKIP_RESOLVE_ELEMS", "ALL", verbose: false
      end
      first = false
      print "\r#{i + 1}/#{zips.size} #{File.basename(zip, '.zip')}   "
    end
    puts
    conn.transaction do
      conn.execute("DELETE FROM road_surfaces")
      { "bulk_bgt_wegdeel" => "wegdeel", "bulk_bgt_ondersteunendwegdeel" => "ondersteunend" }.each do |table, layer|
        n = conn.exec_update(<<~SQL)
          INSERT INTO road_surfaces (source_id, layer, function, material, geom, created_at, updated_at)
          SELECT DISTINCT ON (gml_id) gml_id, '#{layer}', function, material, ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)), now(), now()
          FROM #{table}
          WHERE eindregistratie IS NULL AND objecteindtijd IS NULL AND NOT ST_IsEmpty(geom)
          ORDER BY gml_id
          ON CONFLICT (source_id) DO UPDATE SET layer = EXCLUDED.layer, function = EXCLUDED.function, material = EXCLUDED.material, geom = EXCLUDED.geom, updated_at = now()
        SQL
        puts "#{layer}: #{n} polygons"
      end
      conn.execute("DROP TABLE " + layers.keys.map { "bulk_#{_1}" }.join(", "))
    end
    puts "road_surfaces by function: " + conn.select_rows("SELECT function, count(*) FROM road_surfaces GROUP BY 1 ORDER BY 2 DESC").map { |f, n| "#{f}=#{n}" }.join(", ")
  end
end
