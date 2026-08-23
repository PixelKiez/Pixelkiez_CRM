import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(), status: text('status').notNull().default('Neu'), priority: text('priority').notNull().default('Mittel'),
  score: integer('score').notNull().default(0), name: text('name').notNull(), category: text('category'), street: text('street'),
  zip: text('zip'), city: text('city'), phone: text('phone'), email: text('email'), website: text('website'),
  websiteStatus: text('website_status').notNull().default('Prüfen'), websiteClass: text('website_class'),
  ageScore: integer('age_score').notNull().default(0), problems: text('problems'), pitch: text('pitch'), source: text('source'),
  lastContact: text('last_contact'), nextAction: text('next_action'), followUp: text('follow_up'), notes: text('notes'),
  updatedAt: text('updated_at').notNull(),
});

export const activities = sqliteTable('activities', {
  id: integer('id').primaryKey({ autoIncrement: true }), leadId: text('lead_id').notNull(), type: text('type').notNull(),
  detail: text('detail'), createdAt: text('created_at').notNull(),
});
