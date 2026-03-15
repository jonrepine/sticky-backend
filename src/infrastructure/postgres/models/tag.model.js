const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Tag = sequelize.define(
    'Tag',
    {
      tag_id: {
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
      tableName: 'tags',
      timestamps: true,
      underscored: true,
      paranoid: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
      indexes: [
        {
          unique: true,
          fields: ['user_id', 'slug']
        }
      ]
    }
  );

  Tag.associate = (models) => {
    Tag.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    Tag.belongsToMany(models.InfoBit, {
      through: models.InfoBitTag,
      foreignKey: 'tag_id',
      otherKey: 'info_bit_id',
      as: 'infoBits'
    });

    Tag.hasMany(models.ActivityEvent, {
      foreignKey: 'tag_id',
      as: 'activityEvents',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });
  };

  return Tag;
};
