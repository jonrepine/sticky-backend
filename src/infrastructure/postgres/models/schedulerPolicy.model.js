const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SchedulerPolicy = sequelize.define(
    'SchedulerPolicy',
    {
      policy_id: {
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
      scope: {
        type: DataTypes.ENUM('user_default', 'category', 'infobit'),
        allowNull: false
      },
      category_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'categories',
          key: 'category_id'
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
      algorithm_key: {
        type: DataTypes.STRING,
        allowNull: false,
        references: {
          model: 'algorithms',
          key: 'algorithm_key'
        }
      },
      params_json: {
        type: DataTypes.JSONB,
        allowNull: false
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      apply_mode: {
        type: DataTypes.ENUM('future_only', 'recalculate_existing'),
        allowNull: false,
        defaultValue: 'future_only'
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      },
      deleted_at: {
        type: DataTypes.DATE,
        allowNull: true
      }
    },
    {
      tableName: 'scheduler_policies',
      timestamps: true,
      underscored: true,
      paranoid: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
      validate: {
        scopeConsistency() {
          if (this.scope === 'user_default' && (this.category_id || this.info_bit_id)) {
            throw new Error('user_default scope cannot include category_id or info_bit_id');
          }
          if (this.scope === 'category' && (!this.category_id || this.info_bit_id)) {
            throw new Error('category scope requires category_id and no info_bit_id');
          }
          if (this.scope === 'infobit' && (!this.info_bit_id || this.category_id)) {
            throw new Error('infobit scope requires info_bit_id and no category_id');
          }
        }
      },
      indexes: [
        {
          fields: ['user_id', 'scope', 'is_active']
        },
        {
          fields: ['user_id', 'category_id', 'is_active']
        },
        {
          fields: ['user_id', 'info_bit_id', 'is_active']
        }
      ]
    }
  );

  SchedulerPolicy.associate = (models) => {
    SchedulerPolicy.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    SchedulerPolicy.belongsTo(models.Category, {
      foreignKey: 'category_id',
      as: 'category',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    SchedulerPolicy.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id',
      as: 'infoBit',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    SchedulerPolicy.belongsTo(models.Algorithm, {
      foreignKey: 'algorithm_key',
      targetKey: 'algorithm_key',
      as: 'algorithm',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });
  };

  return SchedulerPolicy;
};
