/**
 * GenerationPolicy — per-user/category/InfoBit LLM generation configuration.
 *
 * Mirrors the SchedulerPolicy inheritance model:
 *   1. InfoBit-level override (future-safe, rarely used)
 *   2. Category-level policy (most common)
 *   3. User default policy
 *   4. System default (hardcoded fallback in resolver)
 *
 * config_json stores the full LLM generation configuration including
 * targetCardCount, requiredCardStyles, creativityLevel, etc. The shape
 * is validated at the resolver level, not the DB level.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const GenerationPolicy = sequelize.define(
    'GenerationPolicy',
    {
      policy_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'user_id' }
      },
      scope: {
        type: DataTypes.ENUM('user_default', 'category', 'infobit'),
        allowNull: false
      },
      category_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'categories', key: 'category_id' }
      },
      info_bit_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'info_bits', key: 'info_bit_id' }
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      config_json: {
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
      },
      deleted_at: {
        type: DataTypes.DATE,
        allowNull: true
      }
    },
    {
      tableName: 'generation_policies',
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
        { fields: ['user_id', 'scope', 'is_active'] },
        { fields: ['user_id', 'category_id', 'is_active'] },
        { fields: ['user_id', 'info_bit_id', 'is_active'] }
      ]
    }
  );

  GenerationPolicy.associate = (models) => {
    GenerationPolicy.belongsTo(models.User, {
      foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE', onUpdate: 'CASCADE'
    });
    GenerationPolicy.belongsTo(models.Category, {
      foreignKey: 'category_id', as: 'category', onDelete: 'CASCADE', onUpdate: 'CASCADE'
    });
    GenerationPolicy.belongsTo(models.InfoBit, {
      foreignKey: 'info_bit_id', as: 'infoBit', onDelete: 'CASCADE', onUpdate: 'CASCADE'
    });
  };

  return GenerationPolicy;
};
