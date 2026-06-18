/**
 * Correspondence module enum constants.
 * Single source of truth for all allowed values — shared between
 * route-level schemas, shared validators, and the frontend.
 */

// ─── Status Enums ───────────────────────────────────────────────────────────────

export const INCOMING_STATUSES = [
  'Received', 'Registered', 'Under Review', 'Referred',
  'Action Taken', 'Closed', 'Archived', 'Cancelled'
] as const;

export const OUTGOING_STATUSES = [
  'Draft', 'Pending Approval', 'Approved', 'Sent',
  'Delivered', 'Archived', 'Cancelled'
] as const;

// ─── Field Enums ────────────────────────────────────────────────────────────────

export const PRIORITIES = [
  'Normal', 'Urgent', 'Very Urgent', 'Confidential', 'Restricted'
] as const;

export const CLASSIFICATIONS = [
  'General', 'Audit Related', 'Compliance',
  'Administrative', 'Financial', 'HR Related'
] as const;

export const METHODS = [
  'Official Mail', 'Hand Delivery', 'Electronic System', 'Email'
] as const;

export const ENTITY_TYPES = [
  'Government', 'Private', 'Internal', 'Regulatory'
] as const;

// ─── Referral & Link Enums ──────────────────────────────────────────────────────

export const REFERRAL_STATUSES = [
  'Pending', 'Acknowledged', 'Completed', 'Returned'
] as const;

export const LINK_TYPES = [
  'Reply', 'Follow-up', 'Related'
] as const;

// ─── Derived Types ──────────────────────────────────────────────────────────────

export type IncomingStatus = typeof INCOMING_STATUSES[number];
export type OutgoingStatus = typeof OUTGOING_STATUSES[number];
export type Priority = typeof PRIORITIES[number];
export type Classification = typeof CLASSIFICATIONS[number];
export type Method = typeof METHODS[number];
export type EntityType = typeof ENTITY_TYPES[number];
export type ReferralStatus = typeof REFERRAL_STATUSES[number];
export type LinkType = typeof LINK_TYPES[number];
