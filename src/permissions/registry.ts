/**
 * Module Registry - Single source of truth for all permission modules.
 *
 * This registry stores module definitions and provides retrieval methods
 * for all consumers: DB seeder, middleware, frontend navigation, and admin UI.
 */

import { ModuleDefinition, NavigationConfig, PermissionAction } from './types';
import { UserRole } from '@alsaqi/shared';

/** Navigation item returned by getNavigationConfig() */
export interface NavigationItem {
  module: string;
  label: { en: string; ar: string };
  icon: string;
  path: string;
  order: number;
  parent?: string;
}

/** Valid PermissionAction values for validation */
const VALID_ACTIONS: PermissionAction[] = ['View', 'Create', 'Edit', 'Delete', 'Approve'];

/** Valid built-in role names */
const VALID_ROLES: string[] = Object.values(UserRole);

/** PascalCase pattern: starts with uppercase letter, followed by alphanumeric */
const PASCAL_CASE_PATTERN = /^[A-Z][a-zA-Z0-9]*$/;

/** Maximum module name length */
const MAX_NAME_LENGTH = 50;

/** Maximum label length */
const MAX_LABEL_LENGTH = 100;

export class ModuleRegistryImpl {
  private modules: Map<string, ModuleDefinition> = new Map();

  /**
   * Register a module definition with full validation.
   * Throws descriptive errors on validation failure.
   */
  register(definition: ModuleDefinition): void {
    this.validateDefinition(definition);
    this.modules.set(definition.name, definition);
  }

  /**
   * Get a module definition by name.
   * Returns undefined if the module is not registered.
   */
  getModule(name: string): ModuleDefinition | undefined {
    return this.modules.get(name);
  }

  /**
   * Get all registered module definitions.
   */
  getAllModules(): ModuleDefinition[] {
    return Array.from(this.modules.values());
  }

  /**
   * Get all registered module names.
   */
  getModuleNames(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Get default permissions for a given role across all registered modules.
   * Returns an empty object for unknown roles (never throws).
   */
  getDefaultPermissions(role: string): Record<string, PermissionAction[]> {
    const result: Record<string, PermissionAction[]> = {};

    for (const [name, mod] of this.modules) {
      const actions = mod.defaults[role];
      if (actions && actions.length > 0) {
        result[name] = [...actions];
      }
    }

    return result;
  }

  /**
   * Get navigation configuration for all modules that have navigation defined.
   * Returns items sorted by order.
   */
  getNavigationConfig(): NavigationItem[] {
    const items: NavigationItem[] = [];

    for (const mod of this.modules.values()) {
      if (mod.navigation) {
        items.push({
          module: mod.name,
          label: mod.label,
          icon: mod.navigation.icon,
          path: mod.navigation.path,
          order: mod.navigation.order,
          parent: mod.navigation.parent,
        });
      }
    }

    return items.sort((a, b) => a.order - b.order);
  }

  /**
   * Validate a module definition. Throws on any validation failure.
   */
  private validateDefinition(definition: ModuleDefinition): void {
    const { name, label, actions, defaults, navigation } = definition;

    // Validate name: unique, PascalCase, 1-50 chars
    if (!name || name.length > MAX_NAME_LENGTH || !PASCAL_CASE_PATTERN.test(name)) {
      throw new Error(
        `Invalid module name: '${name}'. Must be PascalCase (^[A-Z][a-zA-Z0-9]*$) and between 1 and 50 characters.`
      );
    }

    if (this.modules.has(name)) {
      throw new Error(`Module '${name}' already registered.`);
    }

    // Validate labels: both en and ar required, 1-100 chars each
    if (!label || !label.en || label.en.length === 0 || label.en.length > MAX_LABEL_LENGTH) {
      throw new Error(
        `Module '${name}': English label is required and must be between 1 and 100 characters.`
      );
    }
    if (!label.ar || label.ar.length === 0 || label.ar.length > MAX_LABEL_LENGTH) {
      throw new Error(
        `Module '${name}': Arabic label is required and must be between 1 and 100 characters.`
      );
    }

    // Validate actions: non-empty, valid values
    if (!actions || actions.length === 0) {
      throw new Error(
        `Module '${name}' must have at least one action.`
      );
    }

    for (const action of actions) {
      if (!VALID_ACTIONS.includes(action)) {
        throw new Error(
          `Module '${name}': Invalid action '${action}'. Valid actions are: ${VALID_ACTIONS.join(', ')}.`
        );
      }
    }

    // Validate defaults: role references must be valid built-in roles
    if (defaults) {
      for (const roleName of Object.keys(defaults)) {
        if (!VALID_ROLES.includes(roleName)) {
          throw new Error(
            `Module '${name}': Invalid role '${roleName}' in defaults. Valid roles are: ${VALID_ROLES.join(', ')}.`
          );
        }
      }
    }

    // Validate navigation path: must start with '/'
    if (navigation && navigation.path) {
      if (!navigation.path.startsWith('/')) {
        throw new Error(
          `Module '${name}': Navigation path must start with '/'. Got: '${navigation.path}'.`
        );
      }
    }
  }

  /**
   * Reset the registry (useful for testing).
   */
  _reset(): void {
    this.modules.clear();
  }
}

/** Singleton ModuleRegistry instance */
export const ModuleRegistry = new ModuleRegistryImpl();
