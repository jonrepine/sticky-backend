const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InfoBitTag = sequelize.define(
    'InfoBitTag',
    {
      info_bit_id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        references: {
          model: 'info_bits',
          key: 'info_bit_id'
        }
      },
      tag_id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        references: {
          model: 'tags',
          key: 'tag_id'
        }
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      }
    },
    {
      tableName: 'info_bit_tags',
      timestamps: false,
      underscored: true
    }
  );

  return InfoBitTag;
};
