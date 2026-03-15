const mongoose = require('mongoose');
const config = require('../../app/config');

async function connectMongo() {
  await mongoose.connect(config.mongodbUri, {
    autoIndex: true
  });
}

module.exports = {
  mongoose,
  connectMongo
};
