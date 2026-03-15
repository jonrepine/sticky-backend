const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ActivityEvent = sequelize.define(
    'ActivityEvent',
    {
      activity_event_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'user_id'
        }
      },
      info_bit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'info_bits',
          key: 'info_bit_id'
        }
      },
      card_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'cards',
          key: 'card_id'
        }
      },
      tag_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'tags',
          key: 'tag_id'
        }
      },
      event_type: {
        type: DataTypes.STRING,
        allowNull: false
      },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {}
      },
      occurred_at: {
        type: DataTypes.DATE,
        allowNull: false
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
      tableName: 'activity_events',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          fields: ['user_id', 'occurred_at']
        }
      ]
    }
  );

  ActivityEvent.associate = (models) => {
    ActivityEvent.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    ActivityEvent.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id',
      as: 'infoBit',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });

    ActivityEvent.belongsTo(models.Card, {
      foreignKey: 'card_id',
      as: 'card',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });

    ActivityEvent.belongsTo(models.Tag, {
      foreignKey: 'tag_id',
      as: 'tag',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });
  };

  return ActivityEvent;
};
