// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleRegistryImpl } from '../registry';
import { ModuleDefinition, PermissionAction } from '../types';
import { UserRole } from '../../constants';

/**
 * Unit tests for ModuleRegistry.
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */

function createValidDefinition(overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    name: 'TestModule',
    label: { en: 'Test Module', ar: 'وحدة اختبار' },
    actions: ['View', 'Create'] as PermissionAction[],
    defaults: {
      [UserRole.ADMIN]: ['View', 'Create'] as PermissionAction[],
    },
    navigation: {
      icon: 'TestIcon',
      path: '/test-module',
      order: 1,
    },
    ...overrides,
  };
}

describe('ModuleRegistry', () => {
  let registry: ModuleRegistryImpl;

  beforeEach(() => {
    registry = new ModuleRegistryImpl();
  });

  describe('Successful registration and retrieval', () => {
    it('should register a valid module definition', () => {
      const def = createValidDefinition();
      expect(() => registry.register(def)).not.toThrow();
    });

    it('should retrieve a registered module by name', () => {
      const def = createValidDefinition();
      registry.register(def);

      const result = registry.getModule('TestModule');
      expect(result).toEqual(def);
    });

    it('should return undefined for unregistered module name', () => {
      expect(registry.getModule('NonExistent')).toBeUndefined();
    });

    it('should return all registered modules via getAllModules()', () => {
      const def1 = createValidDefinition({ name: 'ModuleA' });
      const def2 = createValidDefinition({ name: 'ModuleB' });
      registry.register(def1);
      registry.register(def2);

      const all = registry.getAllModules();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(def1);
      expect(all).toContainEqual(def2);
    });

    it('should return all registered module names via getModuleNames()', () => {
      registry.register(createValidDefinition({ name: 'Alpha' }));
      registry.register(createValidDefinition({ name: 'Beta' }));
      registry.register(createValidDefinition({ name: 'Gamma' }));

      const names = registry.getModuleNames();
      expect(names).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('should register a module without navigation config', () => {
      const def = createValidDefinition({ navigation: undefined });
      expect(() => registry.register(def)).not.toThrow();
      expect(registry.getModule('TestModule')).toEqual(def);
    });

    it('should register a module with fileScope flag', () => {
      const def = createValidDefinition({ fileScope: true });
      registry.register(def);
      expect(registry.getModule('TestModule')?.fileScope).toBe(true);
    });
  });

  describe('Duplicate name rejection (Requirement 1.5)', () => {
    it('should reject registration of a duplicate module name', () => {
      registry.register(createValidDefinition({ name: 'Analytics' }));

      expect(() => registry.register(createValidDefinition({ name: 'Analytics' }))).toThrow(
        /Analytics.*already registered/
      );
    });

    it('should include the module name in the duplicate error message', () => {
      registry.register(createValidDefinition({ name: 'Policies' }));

      expect(() => registry.register(createValidDefinition({ name: 'Policies' }))).toThrow(
        'Policies'
      );
    });
  });

  describe('Invalid PascalCase name rejection (Requirement 1.2)', () => {
    it('should reject a name starting with lowercase', () => {
      expect(() => registry.register(createValidDefinition({ name: 'analytics' }))).toThrow(
        /Invalid module name/
      );
    });

    it('should reject a name with special characters', () => {
      expect(() => registry.register(createValidDefinition({ name: 'My-Module' }))).toThrow(
        /Invalid module name/
      );
    });

    it('should reject a name with spaces', () => {
      expect(() => registry.register(createValidDefinition({ name: 'My Module' }))).toThrow(
        /Invalid module name/
      );
    });

    it('should reject a name with underscores', () => {
      expect(() => registry.register(createValidDefinition({ name: 'My_Module' }))).toThrow(
        /Invalid module name/
      );
    });

    it('should reject an empty name', () => {
      expect(() => registry.register(createValidDefinition({ name: '' }))).toThrow(
        /Invalid module name/
      );
    });

    it('should reject a name longer than 50 characters', () => {
      const longName = 'A' + 'a'.repeat(50); // 51 chars
      expect(() => registry.register(createValidDefinition({ name: longName }))).toThrow(
        /Invalid module name/
      );
    });

    it('should accept a name exactly 50 characters long', () => {
      const name50 = 'A' + 'a'.repeat(49); // 50 chars
      expect(() => registry.register(createValidDefinition({ name: name50 }))).not.toThrow();
    });

    it('should accept a single uppercase letter as name', () => {
      expect(() => registry.register(createValidDefinition({ name: 'A' }))).not.toThrow();
    });

    it('should accept alphanumeric PascalCase names', () => {
      expect(() => registry.register(createValidDefinition({ name: 'Module2Test' }))).not.toThrow();
    });
  });

  describe('Empty actions rejection (Requirement 1.3)', () => {
    it('should reject registration with an empty actions array', () => {
      expect(() => registry.register(createValidDefinition({ actions: [] }))).toThrow(
        /at least one action/
      );
    });

    it('should include the module name in the empty actions error', () => {
      expect(() =>
        registry.register(createValidDefinition({ name: 'EmptyActions', actions: [] }))
      ).toThrow(/EmptyActions/);
    });
  });

  describe('Invalid action values rejection (Requirement 1.4)', () => {
    it('should reject an invalid action value', () => {
      expect(() =>
        registry.register(createValidDefinition({ actions: ['View', 'Read' as any] }))
      ).toThrow(/Invalid action.*Read/);
    });

    it('should reject lowercase action values', () => {
      expect(() =>
        registry.register(createValidDefinition({ actions: ['view' as any] }))
      ).toThrow(/Invalid action/);
    });

    it('should include the module name in the invalid action error', () => {
      expect(() =>
        registry.register(
          createValidDefinition({ name: 'BadActions', actions: ['Unknown' as any] })
        )
      ).toThrow(/BadActions/);
    });

    it('should accept all valid action values', () => {
      const allActions: PermissionAction[] = ['View', 'Create', 'Edit', 'Delete', 'Approve'];
      expect(() =>
        registry.register(createValidDefinition({ actions: allActions }))
      ).not.toThrow();
    });
  });

  describe('Invalid role reference rejection (Requirement 1.7)', () => {
    it('should reject defaults referencing an invalid role name', () => {
      expect(() =>
        registry.register(
          createValidDefinition({
            defaults: { InvalidRole: ['View'] as PermissionAction[] },
          })
        )
      ).toThrow(/Invalid role.*InvalidRole/);
    });

    it('should include the module name in the invalid role error', () => {
      expect(() =>
        registry.register(
          createValidDefinition({
            name: 'BadRole',
            defaults: { FakeRole: ['View'] as PermissionAction[] },
          })
        )
      ).toThrow(/BadRole/);
    });

    it('should accept all valid built-in role names', () => {
      const defaults: Record<string, PermissionAction[]> = {
        [UserRole.ADMIN]: ['View'],
        [UserRole.INTERNAL_AUDITOR]: ['View'],
        [UserRole.COMPLIANCE_OFFICER]: ['View'],
        [UserRole.RISK_OFFICER]: ['View'],
        [UserRole.MANAGER]: ['View'],
        [UserRole.VIEWER]: ['View'],
      };
      expect(() => registry.register(createValidDefinition({ defaults }))).not.toThrow();
    });
  });

  describe('Invalid navigation path rejection (Requirement 1.8)', () => {
    it('should reject a navigation path not starting with /', () => {
      expect(() =>
        registry.register(
          createValidDefinition({
            navigation: { icon: 'Icon', path: 'no-slash', order: 1 },
          })
        )
      ).toThrow(/Navigation path must start with/);
    });

    it('should include the module name in the navigation path error', () => {
      expect(() =>
        registry.register(
          createValidDefinition({
            name: 'BadPath',
            navigation: { icon: 'Icon', path: 'relative/path', order: 1 },
          })
        )
      ).toThrow(/BadPath/);
    });

    it('should accept a navigation path starting with /', () => {
      expect(() =>
        registry.register(
          createValidDefinition({
            navigation: { icon: 'Icon', path: '/valid-path', order: 1 },
          })
        )
      ).not.toThrow();
    });
  });

  describe('Missing/empty bilingual labels rejection (Requirement 11.1, 11.2)', () => {
    it('should reject a missing English label', () => {
      expect(() =>
        registry.register(createValidDefinition({ label: { en: '', ar: 'عربي' } }))
      ).toThrow(/English label/);
    });

    it('should reject a missing Arabic label', () => {
      expect(() =>
        registry.register(createValidDefinition({ label: { en: 'English', ar: '' } }))
      ).toThrow(/Arabic label/);
    });

    it('should reject an English label exceeding 100 characters', () => {
      const longLabel = 'A'.repeat(101);
      expect(() =>
        registry.register(createValidDefinition({ label: { en: longLabel, ar: 'عربي' } }))
      ).toThrow(/English label/);
    });

    it('should reject an Arabic label exceeding 100 characters', () => {
      const longLabel = 'ع'.repeat(101);
      expect(() =>
        registry.register(createValidDefinition({ label: { en: 'English', ar: longLabel } }))
      ).toThrow(/Arabic label/);
    });

    it('should accept labels exactly 100 characters long', () => {
      const label100 = 'A'.repeat(100);
      expect(() =>
        registry.register(createValidDefinition({ label: { en: label100, ar: label100 } }))
      ).not.toThrow();
    });
  });

  describe('getDefaultPermissions() (Requirement 1.6)', () => {
    it('should return empty object for unknown roles', () => {
      registry.register(
        createValidDefinition({
          defaults: { [UserRole.ADMIN]: ['View', 'Create'] as PermissionAction[] },
        })
      );

      const result = registry.getDefaultPermissions('UnknownRole');
      expect(result).toEqual({});
    });

    it('should return correct defaults for a known role', () => {
      registry.register(
        createValidDefinition({
          name: 'ModuleA',
          defaults: {
            [UserRole.ADMIN]: ['View', 'Create'] as PermissionAction[],
            [UserRole.VIEWER]: ['View'] as PermissionAction[],
          },
        })
      );
      registry.register(
        createValidDefinition({
          name: 'ModuleB',
          defaults: {
            [UserRole.ADMIN]: ['View', 'Edit'] as PermissionAction[],
          },
        })
      );

      const adminDefaults = registry.getDefaultPermissions(UserRole.ADMIN);
      expect(adminDefaults).toEqual({
        ModuleA: ['View', 'Create'],
        ModuleB: ['View', 'Edit'],
      });

      const viewerDefaults = registry.getDefaultPermissions(UserRole.VIEWER);
      expect(viewerDefaults).toEqual({
        ModuleA: ['View'],
      });
    });

    it('should not include modules where the role has no defaults', () => {
      registry.register(
        createValidDefinition({
          name: 'OnlyAdmin',
          defaults: { [UserRole.ADMIN]: ['View'] as PermissionAction[] },
        })
      );

      const viewerDefaults = registry.getDefaultPermissions(UserRole.VIEWER);
      expect(viewerDefaults).toEqual({});
      expect(Object.keys(viewerDefaults)).not.toContain('OnlyAdmin');
    });
  });

  describe('getNavigationConfig() (Requirement 1.6)', () => {
    it('should return navigation items sorted by order', () => {
      registry.register(
        createValidDefinition({
          name: 'Third',
          navigation: { icon: 'Icon3', path: '/third', order: 30 },
        })
      );
      registry.register(
        createValidDefinition({
          name: 'First',
          navigation: { icon: 'Icon1', path: '/first', order: 10 },
        })
      );
      registry.register(
        createValidDefinition({
          name: 'Second',
          navigation: { icon: 'Icon2', path: '/second', order: 20 },
        })
      );

      const navItems = registry.getNavigationConfig();
      expect(navItems).toHaveLength(3);
      expect(navItems[0].module).toBe('First');
      expect(navItems[1].module).toBe('Second');
      expect(navItems[2].module).toBe('Third');
    });

    it('should exclude modules without navigation config', () => {
      registry.register(createValidDefinition({ name: 'WithNav', navigation: { icon: 'I', path: '/nav', order: 1 } }));
      registry.register(createValidDefinition({ name: 'WithoutNav', navigation: undefined }));

      const navItems = registry.getNavigationConfig();
      expect(navItems).toHaveLength(1);
      expect(navItems[0].module).toBe('WithNav');
    });

    it('should include bilingual labels in navigation items', () => {
      registry.register(
        createValidDefinition({
          name: 'Labeled',
          label: { en: 'English Label', ar: 'تسمية عربية' },
          navigation: { icon: 'Icon', path: '/labeled', order: 1 },
        })
      );

      const navItems = registry.getNavigationConfig();
      expect(navItems[0].label).toEqual({ en: 'English Label', ar: 'تسمية عربية' });
    });

    it('should include parent in navigation items when specified', () => {
      registry.register(
        createValidDefinition({
          name: 'Child',
          navigation: { icon: 'Icon', path: '/child', order: 1, parent: 'ParentModule' },
        })
      );

      const navItems = registry.getNavigationConfig();
      expect(navItems[0].parent).toBe('ParentModule');
    });

    it('should return empty array when no modules have navigation', () => {
      registry.register(createValidDefinition({ navigation: undefined }));
      expect(registry.getNavigationConfig()).toEqual([]);
    });
  });
});
