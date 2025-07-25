/*
 * Copyright 2020 The Yorkie Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TimeTicket } from '@yorkie-js/sdk/src/document/time/ticket';
import { CRDTRoot } from '@yorkie-js/sdk/src/document/crdt/root';
import { CRDTArray } from '@yorkie-js/sdk/src/document/crdt/array';
import {
  Operation,
  ExecutionResult,
} from '@yorkie-js/sdk/src/document/operation/operation';
import { Code, YorkieError } from '@yorkie-js/sdk/src/util/error';

/**
 * `MoveOperation` is an operation representing moving an element to an Array.
 */
export class MoveOperation extends Operation {
  private prevCreatedAt: TimeTicket;
  private createdAt: TimeTicket;

  constructor(
    parentCreatedAt: TimeTicket,
    prevCreatedAt: TimeTicket,
    createdAt: TimeTicket,
    executedAt?: TimeTicket,
  ) {
    super(parentCreatedAt, executedAt);
    this.prevCreatedAt = prevCreatedAt;
    this.createdAt = createdAt;
  }

  /**
   * `create` creates a new instance of MoveOperation.
   */
  public static create(
    parentCreatedAt: TimeTicket,
    prevCreatedAt: TimeTicket,
    createdAt: TimeTicket,
    executedAt?: TimeTicket,
  ): MoveOperation {
    return new MoveOperation(
      parentCreatedAt,
      prevCreatedAt,
      createdAt,
      executedAt,
    );
  }

  /**
   * `execute` executes this operation on the given `CRDTRoot`.
   */
  public execute(root: CRDTRoot): ExecutionResult {
    const parentObject = root.findByCreatedAt(this.getParentCreatedAt());
    if (!parentObject) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `fail to find ${this.getParentCreatedAt()}`,
      );
    }
    if (!(parentObject instanceof CRDTArray)) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `fail to execute, only array can execute move`,
      );
    }
    const array = parentObject as CRDTArray;
    const reverseOp = this.toReverseOperation(array);

    const previousIndex = Number(array.subPathOf(this.createdAt));
    array.moveAfter(this.prevCreatedAt, this.createdAt, this.getExecutedAt());
    const index = Number(array.subPathOf(this.createdAt));
    return {
      opInfos: [
        {
          type: 'move',
          path: root.createPath(this.getParentCreatedAt()),
          index,
          previousIndex,
        },
      ],
      reverseOp,
    };
  }

  private toReverseOperation(array: CRDTArray): Operation {
    const preservePrevCreatedAt = array.getPrevCreatedAt(this.createdAt);
    // NOTE(KMSstudio): executedAt is assigned just before execution, when Document.undo() is called.
    return MoveOperation.create(
      this.getParentCreatedAt(),
      preservePrevCreatedAt,
      this.createdAt,
    );
  }

  /**
   * `getEffectedCreatedAt` returns the creation time of the effected element.
   */
  public getEffectedCreatedAt(): TimeTicket {
    return this.createdAt;
  }

  /**
   * `toTestString` returns a string containing the meta data.
   */
  public toTestString(): string {
    return `${this.getParentCreatedAt().toTestString()}.MOVE`;
  }

  /**
   * `getPrevCreatedAt` returns the creation time of previous element.
   */
  public getPrevCreatedAt(): TimeTicket {
    return this.prevCreatedAt;
  }

  /**
   * `getCreatedAt` returns the creation time of the target element.
   */
  public getCreatedAt(): TimeTicket {
    return this.createdAt;
  }
}
