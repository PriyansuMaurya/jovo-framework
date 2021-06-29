import { JovoResponse } from '@jovotech/output';
import { UserData } from './interfaces';
import { Jovo } from './Jovo';
import { JovoRequest } from './JovoRequest';
import { JovoSession, PersistableSessionData } from './JovoSession';

export type JovoUserConstructor<
  REQUEST extends JovoRequest,
  RESPONSE extends JovoResponse,
  JOVO extends Jovo<REQUEST, RESPONSE>,
> = new (jovo: JOVO) => JovoUser<REQUEST, RESPONSE, JOVO>;

export interface PersistableUserData {
  data: UserData;
  // createdAt: Date;
  // updatedAt: Date;
}

export abstract class JovoUser<
  REQUEST extends JovoRequest,
  RESPONSE extends JovoResponse,
  JOVO extends Jovo<REQUEST, RESPONSE>,
> {
  createdAt: Date = new Date();
  updatedAt: Date = new Date();
  $data: UserData = {};

  constructor(readonly jovo: JOVO) {}

  abstract id: string;

  isNew = true;

  getPersistableData(): PersistableUserData {
    return {
      data: this.$data,
    };
  }

  setPersistableData(data: PersistableUserData): this {
    this.$data = data.data;
    return this;
  }

  getDefaultPersistableData(): PersistableUserData {
    return {
      data: {},
    };
  }

  toJSON() {
    return { ...this, jovo: undefined };
  }
}
