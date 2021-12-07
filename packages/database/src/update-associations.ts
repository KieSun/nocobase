import {
  Sequelize,
  ModelCtor,
  Model,
  DataTypes,
  Utils,
  Association,
  HasOne,
  BelongsTo,
  BelongsToMany,
  HasMany,
} from 'sequelize';
import { UpdateGuard } from './update-guard';
import { TransactionAble } from './repository';

function isUndefinedOrNull(value: any) {
  return typeof value === 'undefined' || value === null;
}

function isStringOrNumber(value: any) {
  return typeof value === 'string' || typeof value === 'number';
}

export function modelAssociations(instance: Model) {
  return (<typeof Model>instance.constructor).associations;
}

export function belongsToManyAssociations(instance: Model): Array<BelongsToMany> {
  const associations = modelAssociations(instance);
  return Object.entries(associations)
    .filter((entry) => {
      const [key, association] = entry;
      return association.associationType == 'BelongsToMany';
    })
    .map((association) => {
      return <BelongsToMany>association[1];
    });
}

export function modelAssociationByKey(instance: Model, key: string): Association {
  return modelAssociations(instance)[key] as Association;
}

type UpdateValue = { [key: string]: any };

interface UpdateOptions extends TransactionAble {
  filter?: any;
  filterByPk?: number | string;
  // 字段白名单
  whitelist?: string[];
  // 字段黑名单
  blacklist?: string[];
  // 关系数据默认会新建并建立关联处理，如果是已存在的数据只关联，但不更新关系数据
  // 如果需要更新关联数据，可以通过 updateAssociationValues 指定
  updateAssociationValues?: string[];
  sanitized?: boolean;
  sourceModel?: Model;
}

export async function updateModelByValues(instance: Model, values: UpdateValue, options?: UpdateOptions) {
  if (!options?.sanitized) {
    const guard = new UpdateGuard();
    //@ts-ignore
    guard.setModel(instance.constructor);
    guard.setBlackList(options.blacklist);
    guard.setWhiteList(options.whitelist);
    guard.setAssociationKeysToBeUpdate(options.updateAssociationValues);
    values = guard.sanitize(values);
  }

  await instance.update(values, options);
  await updateAssociations(instance, values, options);
}

export async function updateThroughTableValue(
  instance: Model,
  throughName: string,
  throughValues: any,
  source: Model,
  transaction = null,
) {
  // update through table values
  for (const belongsToMany of belongsToManyAssociations(instance)) {
    // @ts-ignore
    const throughModel = belongsToMany.through.model;
    const throughModelName = throughModel.name;

    if (throughModelName === throughModelName) {
      const where = {
        [belongsToMany.foreignKey]: instance.get(belongsToMany.sourceKey),
        [belongsToMany.otherKey]: source.get(belongsToMany.targetKey),
      };

      return await throughModel.update(throughValues, {
        where,
        transaction,
      });
    }
  }
}

/**
 * update association of instance by values
 * @param instance
 * @param values
 * @param options
 */
export async function updateAssociations(instance: Model, values: any, options: any = {}) {
  // if no values set, return
  if (!values) {
    return;
  }

  let newTransaction = false;
  let transaction = options.transaction;

  if (!transaction) {
    newTransaction = true;
    transaction = await instance.sequelize.transaction();
  }

  for (const key of Object.keys(modelAssociations(instance))) {
    if (values[key]) {
      await updateAssociation(instance, key, values[key], {
        ...options,
        transaction,
      });
    }
  }

  // update through table values
  for (const belongsToMany of belongsToManyAssociations(instance)) {
    // @ts-ignore
    const throughModel = belongsToMany.through.model;
    const throughModelName = throughModel.name;

    if (values[throughModelName] && options.sourceModel) {
      const where = {
        [belongsToMany.foreignKey]: instance.get(belongsToMany.sourceKey),
        [belongsToMany.otherKey]: options.sourceModel.get(belongsToMany.targetKey),
      };

      await throughModel.update(values[throughModel.name], {
        where,
        transaction,
      });
    }
  }

  if (newTransaction) {
    await transaction.commit();
  }
}

/**
 * update model association by key
 * @param instance
 * @param key
 * @param value
 * @param options
 */
export async function updateAssociation(instance: Model, key: string, value: any, options: any = {}) {
  const association = modelAssociationByKey(instance, key);

  if (!association) {
    return false;
  }

  switch (association.associationType) {
    case 'HasOne':
    case 'BelongsTo':
      return updateSingleAssociation(instance, key, value, options);
    case 'HasMany':
    case 'BelongsToMany':
      return updateMultipleAssociation(instance, key, value, options);
  }
}

/**
 * update belongsTo and HasOne
 * @param model
 * @param key
 * @param value
 * @param options
 */
export async function updateSingleAssociation(model: Model, key: string, value: any, options: any = {}) {
  const association = <HasOne | BelongsTo>modelAssociationByKey(model, key);

  if (!association) {
    return false;
  }

  if (!['undefined', 'string', 'number', 'object'].includes(typeof value)) {
    return false;
  }

  const { transaction = await model.sequelize.transaction() } = options;

  try {
    // set method of association
    const setAccessor = association.accessors.set;

    const removeAssociation = async () => {
      await model[setAccessor](null, { transaction });
      model.setDataValue(key, null);
      if (!options.transaction) {
        await transaction.commit();
      }
      return true;
    };

    if (isUndefinedOrNull(value)) {
      return await removeAssociation();
    }

    if (isStringOrNumber(value)) {
      await model[setAccessor](value, { transaction });
      if (!options.transaction) {
        await transaction.commit();
      }
      return true;
    }
    if (value instanceof Model) {
      await model[setAccessor](value);
      model.setDataValue(key, value);
      if (!options.transaction) {
        await transaction.commit();
      }
      return true;
    }

    const createAccessor = association.accessors.create;
    let dataKey: string;
    let M: ModelCtor<Model>;
    if (association.associationType === 'BelongsTo') {
      M = association.target;
      // @ts-ignore
      dataKey = association.targetKey;
    } else {
      M = association.source;
      dataKey = M.primaryKeyAttribute;
    }

    if (isStringOrNumber(value[dataKey])) {
      let instance: any = await M.findOne({
        where: {
          [dataKey]: value[dataKey],
        },
        transaction,
      });
      if (instance) {
        await model[setAccessor](instance);
        await updateAssociations(instance, value, { transaction, ...options });
        model.setDataValue(key, instance);
        if (!options.transaction) {
          await transaction.commit();
        }
        return true;
      }
    }

    if (value[dataKey] === null) {
      return await removeAssociation();
    }

    const instance = await model[createAccessor](value, { transaction });
    await updateAssociations(instance, value, { transaction, ...options });
    model.setDataValue(key, instance);
    // @ts-ignore
    if (association.targetKey) {
      model.setDataValue(association.foreignKey, instance[dataKey]);
    }
    if (!options.transaction) {
      await transaction.commit();
    }
  } catch (error) {
    if (!options.transaction) {
      await transaction.rollback();
    }
    throw error;
  }
}

/**
 * update multiple association of model by value
 * @param model
 * @param key
 * @param value
 * @param options
 */
export async function updateMultipleAssociation(model: Model, key: string, value: any, options: any = {}) {
  const association = <BelongsToMany | HasMany>modelAssociationByKey(model, key);

  if (!association) {
    return false;
  }

  if (!['undefined', 'string', 'number', 'object'].includes(typeof value)) {
    return false;
  }

  const { transaction = await model.sequelize.transaction() } = options;

  try {
    const setAccessor = association.accessors.set;

    const createAccessor = association.accessors.create;
    if (isUndefinedOrNull(value)) {
      await model[setAccessor](null, { transaction });
      model.setDataValue(key, null);
      return;
    }

    if (isStringOrNumber(value)) {
      await model[setAccessor](value, { transaction });
      return;
    }

    if (!Array.isArray(value)) {
      value = [value];
    }

    const list1 = []; // to be setted
    const list2 = []; // to be added
    for (const item of value) {
      if (isUndefinedOrNull(item)) {
        continue;
      }
      if (isStringOrNumber(item)) {
        list1.push(item);
      } else if (item instanceof Model) {
        list1.push(item);
      } else if (item.sequelize) {
        list1.push(item);
      } else if (typeof item === 'object') {
        list2.push(item);
      }
    }

    // associate targets in lists1
    await model[setAccessor](list1, { transaction });

    const list3 = [];
    for (const item of list2) {
      const pk = association.target.primaryKeyAttribute;

      const through = (<any>association).through ? (<any>association).through.model.name : null;

      const accessorOptions = {
        transaction,
      };

      const throughValue = item[through];

      if (throughValue) {
        accessorOptions['through'] = throughValue;
      }

      if (isUndefinedOrNull(item[pk])) {
        // create new record
        const instance = await model[createAccessor](item, accessorOptions);
        await updateAssociations(instance, item, { transaction, ...options });
        list3.push(instance);
      } else {
        // set & update record
        const instance = await association.target.findByPk(item[pk], {
          transaction,
        });
        const addAccessor = association.accessors.add;

        await model[addAccessor](item[pk], accessorOptions);
        await updateAssociations(instance, item, { transaction, ...options });
        list3.push(instance);
      }
    }

    model.setDataValue(key, list1.concat(list3));
    if (!options.transaction) {
      await transaction.commit();
    }
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}