const defineUser = require('./user.model');
const defineAuthIdentity = require('./authIdentity.model');
const defineSession = require('./session.model');
const defineCategory = require('./category.model');
const defineTag = require('./tag.model');
const defineInfoBit = require('./infoBit.model');
const defineCard = require('./card.model');
const defineInfoBitTag = require('./infoBitTag.model');
const defineAlgorithm = require('./algorithm.model');
const defineSchedulerPolicy = require('./schedulerPolicy.model');
const defineFSRSCardState = require('./fsrsCardState.model');
const defineFSRSReviewLog = require('./fsrsReviewLog.model');
const defineActivityEvent = require('./activityEvent.model');
const defineFlag = require('./flag.model');
const defineGenerationPolicy = require('./generationPolicy.model');
const defineUserLearningPreferences = require('./userLearningPreferences.model');

function initModels(sequelize) {
  const models = {
    User: defineUser(sequelize),
    AuthIdentity: defineAuthIdentity(sequelize),
    Session: defineSession(sequelize),
    Category: defineCategory(sequelize),
    Tag: defineTag(sequelize),
    InfoBit: defineInfoBit(sequelize),
    Card: defineCard(sequelize),
    InfoBitTag: defineInfoBitTag(sequelize),
    Algorithm: defineAlgorithm(sequelize),
    SchedulerPolicy: defineSchedulerPolicy(sequelize),
    FSRSCardState: defineFSRSCardState(sequelize),
    FSRSReviewLog: defineFSRSReviewLog(sequelize),
    ActivityEvent: defineActivityEvent(sequelize),
    Flag: defineFlag(sequelize),
    GenerationPolicy: defineGenerationPolicy(sequelize),
    UserLearningPreferences: defineUserLearningPreferences(sequelize)
  };

  Object.values(models).forEach((model) => {
    if (typeof model.associate === 'function') {
      model.associate(models);
    }
  });

  return models;
}

module.exports = {
  initModels
};
