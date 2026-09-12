# CBS wijken en buurten (CC BY 4.0): the average value of a house per neighbourhood, which is where the price tag on
# every building in the game comes from. CBS publishes `gemiddeldeWoningwaarde` — the mean WOZ assessment of the
# dwellings in a buurt, in thousands of euros — and the number of dwellings; between them that is the total value of
# the housing there. Spread over the floor area our own BAG buildings add up to inside the same buurt, it becomes a
# price per square metre, and one building's worth is its own floor area at that rate.
#
# It is an estimate and it is meant to be: a shed gets shed money, a villa gets villa money, a block of flats gets
# roughly the forty dwellings it holds, and the sum over a neighbourhood comes back out at what CBS says it is.
class Neighbourhood < ApplicationRecord
  DEFAULT_RATE = 1800.0                 # €/m², used where CBS suppressed the value (too few dwellings to publish)

  validates :code, :geom, presence: true

  # The rate to use for a building standing at (x, y) in RD, falling back to the province median where CBS has no
  # figure for the buurt at all.
  def self.rate_at(x, y)
    connection.select_value(<<~SQL)&.to_f || DEFAULT_RATE
      SELECT rate FROM neighbourhoods
      WHERE rate IS NOT NULL AND ST_Contains(geom, ST_SetSRID(ST_Point(#{x.to_f}, #{y.to_f}), 28992))
      LIMIT 1
    SQL
  end

  def self.median_rate
    connection.select_value("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY rate) FROM neighbourhoods WHERE rate > 0")&.to_f || DEFAULT_RATE
  end
end
