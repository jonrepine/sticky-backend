/**
 * NoteSpec validator — read-only structural quality checks.
 *
 * Runs heuristic checks against an InfoBit's noteSpec and its active cards
 * to detect common quality issues in LLM-generated content. Advisory only —
 * never blocks creation or review.
 *
 * Gated behind the ENABLE_NOTESPEC_VALIDATOR feature flag.
 */

const config = require('../../app/config');
const { requireUser } = require('../../shared/auth/requireUser');

const CHECKS = [
  {
    name: 'CORE_ANSWER_CONSISTENT',
    run: (noteSpec, cards) => {
      const core = noteSpec.coreAnswer.toLowerCase();
      const allContain = cards.every((c) => {
        const backText = (c.back_blocks || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join(' ')
          .toLowerCase();
        return backText.includes(core);
      });
      return {
        passed: allContain,
        message: allContain ? null : 'Some cards do not contain the core answer in back blocks'
      };
    }
  },
  {
    name: 'DEEP_ATTRIBUTES_PRESENT',
    run: (noteSpec, cards) => {
      if (!noteSpec.selectedDeepAttributes?.length) return { passed: true, message: null };
      const allBackText = cards
        .map((c) => (c.back_blocks || []).filter((b) => b.type === 'text').map((b) => b.text || '').join(' ').toLowerCase())
        .join(' ');
      const missing = noteSpec.selectedDeepAttributes.filter((attr) => {
        const value = (noteSpec.deepAttributes?.[attr] || '').toLowerCase();
        return value && !allBackText.includes(value);
      });
      return {
        passed: missing.length === 0,
        message: missing.length ? `Missing deep attributes in cards: ${missing.join(', ')}` : null
      };
    }
  },
  {
    name: 'BACK_STARTS_WITH_CORE',
    run: (noteSpec, cards) => {
      const core = noteSpec.coreAnswer.toLowerCase().trim();
      const allStart = cards.every((c) => {
        const firstTextBlock = (c.back_blocks || []).find((b) => b.type === 'text');
        return firstTextBlock && (firstTextBlock.text || '').toLowerCase().trim().startsWith(core);
      });
      return {
        passed: allStart,
        message: allStart ? null : 'Some cards do not start their back with the core answer'
      };
    }
  },
  {
    name: 'NO_TRUE_FALSE_STYLE',
    run: (_noteSpec, cards) => {
      const forbidden = /^(true|false|yes|no)\s*[.?!]?\s*$/i;
      const hasBad = cards.some((c) => {
        const frontText = (c.front_blocks || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join(' ')
          .trim();
        return forbidden.test(frontText);
      });
      return {
        passed: !hasBad,
        message: hasBad ? 'Cards should not use true/false or yes/no as front text' : null
      };
    }
  },
  {
    name: 'FRONT_HAS_REMINDER',
    run: (noteSpec, cards) => {
      if (!noteSpec.frontReminderText) return { passed: true, message: null };
      const reminder = noteSpec.frontReminderText.toLowerCase();
      const anyHas = cards.some((c) => {
        const frontText = (c.front_blocks || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join(' ')
          .toLowerCase();
        return frontText.includes(reminder);
      });
      return {
        passed: anyHas,
        message: anyHas ? null : 'No card front includes the frontReminderText'
      };
    }
  },
  {
    name: 'MAX_FACTS_RESPECTED',
    run: (noteSpec, cards) => {
      const max = noteSpec.maxIndependentFactsPerNote || 1;
      const passed = cards.length <= max;
      return {
        passed,
        message: passed ? null : `${cards.length} cards exceed maxIndependentFactsPerNote (${max})`
      };
    }
  }
];

function runAllChecks(noteSpec, cards) {
  return CHECKS.map((check) => ({
    name: check.name,
    ...check.run(noteSpec, cards)
  }));
}

const validatorQueries = {
  validateNoteSpec: async (_, { infoBitId }, context) => {
    const user = requireUser(context);

    if (!config.featureFlags.noteSpecValidator) {
      throw new Error('NoteSpec validator is not enabled');
    }

    const infoBit = await context.models.InfoBit.findOne({
      where: { info_bit_id: infoBitId, user_id: user.userId }
    });
    if (!infoBit) throw new Error('InfoBit not found');
    if (!infoBit.note_spec_json) throw new Error('InfoBit has no noteSpec');

    const mongoDoc = await context.mongoModels.InfoBitContent.findById(infoBitId).lean();
    const activeCards = (mongoDoc?.cards || []).filter((c) => c.status === 'active');

    const checks = runAllChecks(infoBit.note_spec_json, activeCards);
    return {
      isValid: checks.every((c) => c.passed),
      checks
    };
  }
};

module.exports = { validatorQueries, runAllChecks };
