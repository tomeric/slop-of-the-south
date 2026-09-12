class CreateNeighbourhoods < ActiveRecord::Migration[8.1]
  def change
    # CBS wijken en buurten: what a house in this neighbourhood is worth on average (gemiddelde WOZ-waarde), and how
    # many dwellings there are. `rate` is what we derive from the two: euros per square metre of floor area.
    create_table :neighbourhoods do |t|
      t.string :code, null: false
      t.string :name
      t.integer :woz                    # gemiddelde woningwaarde, thousands of euros
      t.integer :dwellings              # woningvoorraad
      t.float :rate                     # euros per m² of floor area, derived from the two above and our own buildings
      t.geometry :geom, srid: 28992, limit: { srid: 28992, type: "multi_polygon" }, null: false
      t.timestamps
      t.index :code, unique: true
      t.index :geom, using: :gist
    end

    # What one building is worth, in euros: its floor area × the rate where it stands.
    add_column :building_meshes, :woz, :integer
    add_column :buildings, :woz, :integer
  end
end
