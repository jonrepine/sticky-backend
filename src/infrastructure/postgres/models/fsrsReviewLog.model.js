const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FSRSReviewLog = sequelize.define(
    'FSRSReviewLog',
    {
      fsrs_review_log_id: {
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
        allowNull: false,
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
      algorithm_key: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'fsrs',
        references: {
          model: 'algorithms',
          key: 'algorithm_key'
        }
      },
      algorithm_version: {
        type: DataTypes.STRING,
        allowNull: false
      },
      rating: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      response_ms: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      reviewed_at: {
        type: DataTypes.DATE,
        allowNull: false
      },
      effective_policy_scope: {
        type: DataTypes.ENUM('user_default', 'category', 'infobit'),
        allowNull: false
      },
      effective_params_snapshot: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      state_before: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      state_after: {
        type: DataTypes.JSONB,
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
      tableName: 'fsrs_review_logs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          fields: ['user_id', 'reviewed_at']
        },
        {
          fields: ['info_bit_id', 'reviewed_at']
        }
      ]
    }
  );

  FSRSReviewLog.associate = (models) => {
    FSRSReviewLog.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    FSRSReviewLog.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id',
      as: 'infoBit',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    FSRSReviewLog.belongsTo(models.Card, {
      foreignKey: 'card_id',
      as: 'card',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });

    FSRSReviewLog.belongsTo(models.Algorithm, {
      foreignKey: 'algorithm_key',
      targetKey: 'algorithm_key',
      as: 'algorithm',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });
  };

  return FSRSReviewLog;
};
