const { Schema, model } = require('mongoose');

const CardBlockSchema = new Schema(
  {
    type: { type: String, required: true },
    text: { type: String, default: null },
    url: { type: String, default: null },
    alt: { type: String, default: null },
    mimeType: { type: String, default: null },
    durationMs: { type: Number, default: null }
  },
  { _id: false }
);

const CardContentSchema = new Schema(
  {
    card_id: { type: String, required: true },
    front_blocks: { type: [CardBlockSchema], default: [] },
    back_blocks: { type: [CardBlockSchema], default: [] },
    status: {
      type: String,
      enum: ['active', 'archived', 'deleted'],
      default: 'active'
    },
    flagged_at: { type: Date, default: null },
    archived_at: { type: Date, default: null },
    deleted_at: { type: Date, default: null },
    last_reviewed_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
  },
  { _id: false }
);

const InfoBitContentSchema = new Schema(
  {
    _id: { type: String, required: true },
    user_id: { type: String, required: true, index: true },
    title: { type: String, required: true },
    original_content: { type: String, default: null },
    tags: { type: [String], default: [] },
    cards: { type: [CardContentSchema], default: [] },
    number_of_cards: { type: Number, default: 0 },
    rotation: {
      last_presented_card_id: { type: String, default: null },
      last_presented_at: { type: Date, default: null }
    },
    version: { type: Number, default: 1 },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
  },
  {
    collection: 'infobit_contents'
  }
);

InfoBitContentSchema.pre('save', function onSave(next) {
  this.number_of_cards = this.cards.length;
  this.updated_at = new Date();
  this.cards.forEach((card) => {
    card.updated_at = new Date();
  });
  next();
});

InfoBitContentSchema.index({ 'cards.card_id': 1 });
InfoBitContentSchema.index({ updated_at: -1 });

module.exports = model('InfoBitContent', InfoBitContentSchema);
