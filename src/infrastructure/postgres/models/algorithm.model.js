const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Algorithm = sequelize.define(
    'Algorithm',
    {
      algorithm_key: {
        type: DataTypes.STRING,
        primaryKey: true
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false
      },
      version: {
        type: DataTypes.STRING,
        allowNull: false
      },
      default_params: {
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
      tableName: 'algorithms',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    }
  );

  Algorithm.associate = (models) => {
    Algorithm.hasMany(models.SchedulerPolicy, {
      foreignKey: 'algorithm_key',
      sourceKey: 'algorithm_key',
      as: 'schedulerPolicies',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });

    Algorithm.hasMany(models.FSRSCardState, {
      foreignKey: 'algorithm_key',
      sourceKey: 'algorithm_key',
      as: 'fsrsStates',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });

    Algorithm.hasMany(models.FSRSReviewLog, {
      foreignKey: 'algorithm_key',
      sourceKey: 'algorithm_key',
      as: 'fsrsReviewLogs',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE'
    });
  };

  return Algorithm;
};
