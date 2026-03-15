const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FSRSCardState = sequelize.define(
    'FSRSCardState',
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
      algorithm_key: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'fsrs',
        references: {
          model: 'algorithms',
          key: 'algorithm_key'
        }
      },
      due: {
        type: DataTypes.DATE,
        allowNull: false
      },
      stability: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0
      },
      difficulty: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0
      },
      elapsed_days: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0
      },
      scheduled_days: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0
      },
      reps: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      lapses: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      state: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      learning_steps: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      last_review: {
        type: DataTypes.DATE,
        allowNull: true
      },
      effective_policy_hash: {
        type: DataTypes.STRING,
        allowNull: true
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
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
      tableName: 'fsrs_card_states',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          fields: ['due']
        }
      ]
    }
  );

  FSRSCardState.associate = (models) => {
    FSRSCardState.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id',
      as: 'infoBit',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    FSRSCardState.belongsTo(models.Algorithm, {
      foreignKey: 'algorithm_key',
      targetKey: 'algorithm_key',
      as: 'algorithm',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });
  };

  return FSRSCardState;
};
