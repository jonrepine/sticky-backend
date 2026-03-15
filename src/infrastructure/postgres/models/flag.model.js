const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Flag = sequelize.define(
    'Flag',
    {
      flag_id: {
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
      entity_type: {
        type: DataTypes.ENUM('infobit', 'card', 'tag'),
        allowNull: false
      },
      entity_id: {
        type: DataTypes.UUID,
        allowNull: false
      },
      flag_type: {
        type: DataTypes.ENUM('needs_edit', 'needs_regenerate', 'needs_media', 'low_quality', 'other'),
        allowNull: false
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      status: {
        type: DataTypes.ENUM('open', 'resolved'),
        allowNull: false,
        defaultValue: 'open'
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: sequelize.literal('CURRENT_TIMESTAMP')
      },
      resolved_at: {
        type: DataTypes.DATE,
        allowNull: true
      }
    },
    {
      tableName: 'flags',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          fields: ['user_id', 'status', 'entity_type']
        },
        {
          fields: ['entity_type', 'entity_id', 'status']
        }
      ]
    }
  );

  Flag.associate = (models) => {
    Flag.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
  };

  return Flag;
};
