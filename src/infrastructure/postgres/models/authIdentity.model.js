const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AuthIdentity = sequelize.define(
    'AuthIdentity',
    {
      auth_identity_id: {
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
      provider: {
        type: DataTypes.ENUM('email_password', 'phone_otp', 'google_oidc'),
        allowNull: false
      },
      provider_subject: {
        type: DataTypes.STRING,
        allowNull: false
      },
      password_hash: {
        type: DataTypes.STRING,
        allowNull: true
      },
      verified_at: {
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
      tableName: 'auth_identities',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['provider', 'provider_subject']
        }
      ]
    }
  );

  AuthIdentity.associate = (models) => {
    AuthIdentity.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });
  };

  return AuthIdentity;
};
