/**
 * UserLearningPreferences — session boot defaults for a user.
 *
 * One row per user. Stores the default category for new sessions, Socratic
 * mode preference, and default tags to pre-fill when creating new InfoBits.
 *
 * Created lazily: the first time a user updates their preferences, a row
 * is upserted. If no row exists, resolvers return system defaults.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserLearningPreferences = sequelize.define(
    'UserLearningPreferences',
    {
      user_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: { model: 'users', key: 'user_id' }
      },
      new_session_default_category_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'categories', key: 'category_id' }
      },
      default_socratic_enabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      default_tags_json: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      }
    },
    {
      tableName: 'user_learning_preferences',
      timestamps: true,
      underscored: true,
      createdAt: false,
      updatedAt: 'updated_at'
    }
  );

  UserLearningPreferences.associate = (models) => {
    UserLearningPreferences.belongsTo(models.User, {
      foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE', onUpdate: 'CASCADE'
    });
    UserLearningPreferences.belongsTo(models.Category, {
      foreignKey: 'new_session_default_category_id', as: 'defaultCategory', onDelete: 'SET NULL', onUpdate: 'CASCADE'
    });
  };

  return UserLearningPreferences;
};
