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
import { VersionVector } from '@yorkie-js/sdk/src/document/time/version_vector';
import { CRDTRoot } from '@yorkie-js/sdk/src/document/crdt/root';
import { RGATreeSplitPos } from '@yorkie-js/sdk/src/document/crdt/rga_tree_split';
import { CRDTText } from '@yorkie-js/sdk/src/document/crdt/text';
import {
  Operation,
  OperationInfo,
  ExecutionResult,
  OpSource,
} from '@yorkie-js/sdk/src/document/operation/operation';
import { Indexable } from '../document';
import { Code, YorkieError } from '@yorkie-js/sdk/src/util/error';

/**
 *  `StyleOperation` is an operation applies the style of the given range to Text.
 */
export class StyleOperation extends Operation {
  private fromPos: RGATreeSplitPos;
  private toPos: RGATreeSplitPos;
  private attributes: Map<string, string>;

  constructor(
    parentCreatedAt: TimeTicket,
    fromPos: RGATreeSplitPos,
    toPos: RGATreeSplitPos,
    attributes: Map<string, string>,
    executedAt: TimeTicket,
  ) {
    super(parentCreatedAt, executedAt);
    this.fromPos = fromPos;
    this.toPos = toPos;
    this.attributes = attributes;
  }

  /**
   * `create` creates a new instance of StyleOperation.
   */
  public static create(
    parentCreatedAt: TimeTicket,
    fromPos: RGATreeSplitPos,
    toPos: RGATreeSplitPos,
    attributes: Map<string, string>,
    executedAt: TimeTicket,
  ): StyleOperation {
    return new StyleOperation(
      parentCreatedAt,
      fromPos,
      toPos,
      attributes,
      executedAt,
    );
  }

  /**
   * `execute` executes this operation on the given `CRDTRoot`.
   */
  public execute<A extends Indexable>(
    root: CRDTRoot,
    _: OpSource,
    versionVector?: VersionVector,
  ): ExecutionResult {
    const parentObject = root.findByCreatedAt(this.getParentCreatedAt());
    if (!parentObject) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `fail to find ${this.getParentCreatedAt()}`,
      );
    }
    if (!(parentObject instanceof CRDTText)) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `fail to execute, only Text can execute edit`,
      );
    }
    const text = parentObject as CRDTText<A>;
    const [pairs, diff, changes] = text.setStyle(
      [this.fromPos, this.toPos],
      this.attributes ? Object.fromEntries(this.attributes) : {},
      this.getExecutedAt(),
      versionVector,
    );

    root.acc(diff);

    for (const pair of pairs) {
      root.registerGCPair(pair);
    }

    return {
      opInfos: changes.map(({ from, to, value }) => {
        return {
          type: 'style',
          from,
          to,
          value,
          path: root.createPath(this.getParentCreatedAt()),
        } as OperationInfo;
      }),
    };
  }

  /**
   * `getEffectedCreatedAt` returns the creation time of the effected element.
   */
  public getEffectedCreatedAt(): TimeTicket {
    return this.getParentCreatedAt();
  }

  /**
   * `toTestString` returns a string containing the meta data.
   */
  public toTestString(): string {
    const parent = this.getParentCreatedAt().toTestString();
    const fromPos = this.fromPos.toTestString();
    const toPos = this.toPos.toTestString();
    const attributes = this.attributes;
    return `${parent}.STYL(${fromPos},${toPos},${JSON.stringify(attributes)})`;
  }

  /**
   * `getFromPos` returns the start point of the editing range.
   */
  public getFromPos(): RGATreeSplitPos {
    return this.fromPos;
  }

  /**
   * `getToPos` returns the end point of the editing range.
   */
  public getToPos(): RGATreeSplitPos {
    return this.toPos;
  }

  /**
   * `getAttributes` returns the attributes of this operation.
   */
  public getAttributes(): Map<string, string> {
    return this.attributes;
  }
}
