class AddDetailToLandCovers < ActiveRecord::Migration[8.1]
  def change
    add_column :land_covers, :detail, :string   # BGT plus-fysiekVoorkomen: the sub-kind, where the source records one
  end
end
