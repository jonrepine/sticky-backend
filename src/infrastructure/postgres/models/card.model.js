const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Card = sequelize.define(
    'Card',
    {
      card_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      info_bit_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'info_bits',
          key: 'info_bit_id'
        }
      },
      status: {
        type: DataTypes.ENUM('active', 'archived', 'deleted'),
        allowNull: false,
        defaultValue: 'active'
      },
      content_version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      last_reviewed_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      flagged_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      archived_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      deleted_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      }
    },
    {
      tableName: 'cards',
      timestamps: true,
      underscored: true,
      paranoid: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at'
    }
  );

  Card.associate = (models) => {
    Card.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id',
      as: 'infoBit',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    Card.hasMany(models.FSRSReviewLog, {
      foreignKey: 'card_id',
      as: 'fsrsReviewLogs',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });

    Card.hasMany(models.ActivityEvent, {
      foreignKey: 'card_id',
      as: 'activityEvents',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });
  };

  return Card;
};
