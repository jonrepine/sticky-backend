const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InfoBit = sequelize.define(
    'InfoBit',
    {
      info_bit_id: {
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
      category_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'categories',
          key: 'category_id'
        }
      },
      title: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      source_type: {
        type: DataTypes.STRING,
        allowNull: true
      },
      status: {
        type: DataTypes.ENUM('pending_content', 'active', 'archived', 'deleted', 'mastered'),
        allowNull: false,
        defaultValue: 'pending_content'
      },
      due_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      note_spec_json: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      archived_at: {
        type: DataTypes.DATE,
        allowNull: true
      },
      mastered_at: {
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
      tableName: 'info_bits',
      timestamps: true,
      underscored: true,
      paranoid: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at'
    }
  );

  InfoBit.associate = (models) => {
    InfoBit.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    InfoBit.belongsTo(models.Category, {
      foreignKey: 'category_id',
      as: 'category',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });

    InfoBit.hasMany(models.Card, {
      foreignKey: 'info_bit_id',
      as: 'cards',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    InfoBit.belongsToMany(models.Tag, {
      through: models.InfoBitTag,
      foreignKey: 'info_bit_id',
      otherKey: 'tag_id',
      as: 'tags'
    });

    InfoBit.hasMany(models.SchedulerPolicy, {
      foreignKey: 'info_bit_id',
      as: 'schedulerPolicies',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    InfoBit.hasOne(models.FSRSCardState, {
      foreignKey: 'info_bit_id',
      as: 'fsrsCardState',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    InfoBit.hasMany(models.FSRSReviewLog, {
      foreignKey: 'info_bit_id',
      as: 'fsrsReviewLogs',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    InfoBit.hasMany(models.ActivityEvent, {
      foreignKey: 'info_bit_id',
      as: 'activityEvents',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });
  };

  return InfoBit;
};
