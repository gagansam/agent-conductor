import { z } from 'zod';

/** Questions beyond this are dropped with a warning: a long list means the task needs rewriting, not answering. */
export const MAX_QUESTIONS = 5;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  /** What changes in the implementation depending on the answer. */
  why: z.string().default(''),
  options: z.array(z.string()).default([]),
  /** What the implementer will do if nobody answers. Must be safe to accept unread. */
  default: z.string().min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

/** The implementer's clarify turn: written as its final message (the turn is read-only). */
export const QuestionsOutputSchema = z.object({
  schema_version: z.literal(1),
  questions: z.array(QuestionSchema).default([]),
  notes: z.string().default(''),
});
export type QuestionsOutput = z.infer<typeof QuestionsOutputSchema>;

/** A judgment call the implementer made itself, cheap to change later. Shown to the operator before review. */
export const OwnChoiceSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  chosen: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  why: z.string().default(''),
});
export type OwnChoice = z.infer<typeof OwnChoiceSchema>;

/**
 * before_coding: asked in the clarify turn. blocking: the implementer stopped mid-work to ask.
 * own_choice: decided by the implementer, then shown to the operator before review.
 */
export type ClarificationStage = 'before_coding' | 'blocking' | 'own_choice';

/** One answered question or reviewed choice, as recorded for the run and carried into every later pack. */
export interface Clarification {
  id: string;
  stage: ClarificationStage;
  question: string;
  answer: string;
  /** operator: a person saw it (pressing Enter on the recommendation counts). default: nobody did. */
  source: 'operator' | 'default';
  /** The implementer's own choice, when the operator replaced it. */
  overruled_from?: string;
}
