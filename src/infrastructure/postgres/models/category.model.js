const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Category = sequelize.define(
    'Category',
    {
      category_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      owner_type: {
        type: DataTypes.ENUM('system', 'user'),
        allowNull: false
      },
      owner_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'users',
          key: 'user_id'
        }
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false
      },
      slug: {
        type: DataTypes.STRING,
        allowNull: false
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
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
      tableName: 'categories',
      timestamps: true,
      underscored: true,
      paranoid: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
      validate: {
        ownerConsistency() {
          if (this.owner_type === 'system' && this.owner_user_id !== null) {
            throw new Error('System categories cannot have owner_user_id');
          }
          if (this.owner_type === 'user' && !this.owner_user_id) {
            throw new Error('User categories must have owner_user_id');
          }
        }
      }
    }
  );

  Category.associate = (models) => {
    Category.belongsTo(models.User, {
      foreignKey: 'owner_user_id',
      as: 'ownerUser',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    Category.hasMany(models.InfoBit, {
      foreignKey: 'category_id',
      as: 'infoBits',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });

    Category.hasMany(models.SchedulerPolicy, {
      foreignKey: 'category_id',
      as: 'schedulerPolicies',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
  };

  return Category;
};
