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

import { ActorID } from '@yorkie-js/sdk/src/document/time/actor_id';
import { Comparator } from '@yorkie-js/sdk/src/util/comparator';
import { SplayNode, SplayTree } from '@yorkie-js/sdk/src/util/splay_tree';
import { LLRBTree } from '@yorkie-js/sdk/src/util/llrb_tree';
import {
  InitialTimeTicket,
  MaxLamport,
  TimeTicket,
  TimeTicketSize,
  TimeTicketStruct,
} from '@yorkie-js/sdk/src/document/time/ticket';
import { VersionVector } from '@yorkie-js/sdk/src/document/time/version_vector';
import { GCChild, GCPair, GCParent } from '@yorkie-js/sdk/src/document/crdt/gc';
import { Code, YorkieError } from '@yorkie-js/sdk/src/util/error';
import {
  DataSize,
  addDataSizes,
  subDataSize,
} from '@yorkie-js/sdk/src/util/resource';

export interface ValueChange<T> {
  actor: ActorID;
  from: number;
  to: number;
  value?: T;
}

interface RGATreeSplitValue {
  length: number;
  substring(indexStart: number, indexEnd?: number): RGATreeSplitValue;
  getDataSize(): DataSize;
}

/**
 * `RGATreeSplitPosStruct` is a structure represents the meta data of the node pos.
 * It is used to serialize and deserialize the node pos.
 */
export type RGATreeSplitPosStruct = {
  id: RGATreeSplitNodeIDStruct;
  relativeOffset: number;
};

/**
 * `RGATreeSplitNodeIDStruct` is a structure represents the meta data of the node id.
 * It is used to serialize and deserialize the node id.
 */
export type RGATreeSplitNodeIDStruct = {
  createdAt: TimeTicketStruct;
  offset: number;
};

/**
 * `RGATreeSplitNodeID` is an ID of RGATreeSplitNode.
 */
export class RGATreeSplitNodeID {
  private createdAt: TimeTicket;
  private offset: number;

  constructor(createdAt: TimeTicket, offset: number) {
    this.createdAt = createdAt;
    this.offset = offset;
  }

  /**
   * `of` creates a instance of RGATreeSplitNodeID.
   */
  public static of(createdAt: TimeTicket, offset: number): RGATreeSplitNodeID {
    return new RGATreeSplitNodeID(createdAt, offset);
  }

  /**
   * `fromStruct` creates a instance of RGATreeSplitNodeID from the struct.
   */
  public static fromStruct(
    struct: RGATreeSplitNodeIDStruct,
  ): RGATreeSplitNodeID {
    return RGATreeSplitNodeID.of(
      TimeTicket.fromStruct(struct.createdAt),
      struct.offset,
    );
  }

  /**
   * `getCreatedAt` returns the creation time of this ID.
   */
  public getCreatedAt(): TimeTicket {
    return this.createdAt;
  }

  /**
   * `getOffset` returns returns the offset of this ID.
   */
  public getOffset(): number {
    return this.offset;
  }

  /**
   * `equals` returns whether given ID equals to this ID or not.
   */
  public equals(other: RGATreeSplitNodeID): boolean {
    return (
      this.createdAt.compare(other.createdAt) === 0 &&
      this.offset === other.offset
    );
  }

  /**
   * `hasSameCreatedAt` returns whether given ID has same creation time with this ID.
   */
  public hasSameCreatedAt(other: RGATreeSplitNodeID): boolean {
    return this.createdAt.compare(other.createdAt) === 0;
  }

  /**
   * `split` creates a new ID with an offset from this ID.
   */
  public split(offset: number): RGATreeSplitNodeID {
    return new RGATreeSplitNodeID(this.createdAt, this.offset + offset);
  }

  /**
   * `toStruct` returns the structure of this node id.
   */
  public toStruct(): RGATreeSplitNodeIDStruct {
    return {
      createdAt: this.createdAt.toStruct(),
      offset: this.offset,
    };
  }

  /**
   * `toTestString` returns a String containing
   * the meta data of the node id for debugging purpose.
   */
  public toTestString(): string {
    return `${this.createdAt.toTestString()}:${this.offset}`;
  }

  /**
   * `toIDString` returns a string that can be used as an ID for this node id.
   */
  public toIDString(): string {
    return `${this.createdAt.toIDString()}:${this.offset}`;
  }
}

const InitialRGATreeSplitNodeID = RGATreeSplitNodeID.of(InitialTimeTicket, 0);

/**
 * `RGATreeSplitPos` is the position of the text inside the node.
 */
export class RGATreeSplitPos {
  private id: RGATreeSplitNodeID;
  private relativeOffset: number;

  constructor(id: RGATreeSplitNodeID, relativeOffset: number) {
    this.id = id;
    this.relativeOffset = relativeOffset;
  }

  /**
   * `of` creates a instance of RGATreeSplitPos.
   */
  public static of(
    id: RGATreeSplitNodeID,
    relativeOffset: number,
  ): RGATreeSplitPos {
    return new RGATreeSplitPos(id, relativeOffset);
  }

  /**
   * `fromStruct` creates a instance of RGATreeSplitPos from the struct.
   */
  public static fromStruct(struct: RGATreeSplitPosStruct): RGATreeSplitPos {
    const id = RGATreeSplitNodeID.fromStruct(struct.id);
    return RGATreeSplitPos.of(id, struct.relativeOffset);
  }

  /**
   * `getID` returns the ID of this RGATreeSplitPos.
   */
  public getID(): RGATreeSplitNodeID {
    return this.id;
  }

  /**
   * `getRelativeOffset` returns the relative offset of this RGATreeSplitPos.
   */
  public getRelativeOffset(): number {
    return this.relativeOffset;
  }

  /**
   * `getAbsoluteID` returns the absolute id of this RGATreeSplitPos.
   */
  public getAbsoluteID(): RGATreeSplitNodeID {
    return RGATreeSplitNodeID.of(
      this.id.getCreatedAt(),
      this.id.getOffset() + this.relativeOffset,
    );
  }

  /**
   *`toTestString` returns a String containing
   * the meta data of the position for debugging purpose.
   */
  public toTestString(): string {
    return `${this.id.toTestString()}:${this.relativeOffset}`;
  }

  /**
   * `toStruct` returns the structure of this node pos.
   */
  public toStruct(): RGATreeSplitPosStruct {
    return {
      id: this.id.toStruct(),
      relativeOffset: this.relativeOffset,
    };
  }

  /**
   * `equals` returns whether given pos equal to this pos or not.
   */
  public equals(other: RGATreeSplitPos): boolean {
    if (!this.id.equals(other.id)) {
      return false;
    }

    return this.relativeOffset === other.relativeOffset;
  }
}

export type RGATreeSplitPosRange = [RGATreeSplitPos, RGATreeSplitPos];

/**
 * `RGATreeSplitNode` is a node of RGATreeSplit.
 */
export class RGATreeSplitNode<T extends RGATreeSplitValue>
  extends SplayNode<T>
  implements GCChild
{
  private id: RGATreeSplitNodeID;
  private removedAt?: TimeTicket;

  private prev?: RGATreeSplitNode<T>;
  private next?: RGATreeSplitNode<T>;
  private insPrev?: RGATreeSplitNode<T>;
  private insNext?: RGATreeSplitNode<T>;

  constructor(id: RGATreeSplitNodeID, value?: T, removedAt?: TimeTicket) {
    super(value!);
    this.id = id;
    this.removedAt = removedAt;
  }

  /**
   * `create` creates a instance of RGATreeSplitNode.
   */
  public static create<T extends RGATreeSplitValue>(
    id: RGATreeSplitNodeID,
    value?: T,
  ): RGATreeSplitNode<T> {
    return new RGATreeSplitNode(id, value);
  }

  /**
   * `createComparator` creates a function to compare two RGATreeSplitNodeID.
   */
  public static createComparator(): Comparator<RGATreeSplitNodeID> {
    return (p1: RGATreeSplitNodeID, p2: RGATreeSplitNodeID): number => {
      const compare = p1.getCreatedAt().compare(p2.getCreatedAt());
      if (compare !== 0) {
        return compare;
      }

      if (p1.getOffset() > p2.getOffset()) {
        return 1;
      } else if (p1.getOffset() < p2.getOffset()) {
        return -1;
      }
      return 0;
    };
  }

  /**
   * `getID` returns the ID of this RGATreeSplitNode.
   */
  public getID(): RGATreeSplitNodeID {
    return this.id;
  }

  /**
   * `getCreatedAt` returns creation time of the Id of RGATreeSplitNode.
   */
  public getCreatedAt(): TimeTicket {
    return this.id.getCreatedAt();
  }

  /**
   * `getLength` returns the length of this node.
   */
  public getLength(): number {
    if (this.removedAt) {
      return 0;
    }
    return this.getContentLength();
  }

  /**
   * `getContentLength` returns the length of this value.
   */
  public getContentLength(): number {
    return (this.value && this.value.length) || 0;
  }

  /**
   * `getPrev` returns a previous node of this node.
   */
  public getPrev(): RGATreeSplitNode<T> | undefined {
    return this.prev;
  }

  /**
   * `getNext` returns a next node of this node.
   */
  public getNext(): RGATreeSplitNode<T> | undefined {
    return this.next;
  }

  /**
   * `getInsPrev` returns a previous node of this node insertion.
   */
  public getInsPrev(): RGATreeSplitNode<T> | undefined {
    return this.insPrev;
  }

  /**
   * `getInsNext` returns a next node of this node insertion.
   */
  public getInsNext(): RGATreeSplitNode<T> | undefined {
    return this.insNext;
  }

  /**
   * `getInsPrevID` returns a ID of previous node insertion.
   */
  public getInsPrevID(): RGATreeSplitNodeID {
    return this.insPrev!.getID();
  }

  /**
   * `setPrev` sets previous node of this node.
   */
  public setPrev(node?: RGATreeSplitNode<T>): void {
    this.prev = node;
    if (node) {
      node.next = this;
    }
  }

  /**
   * `setNext` sets next node of this node.
   */
  public setNext(node?: RGATreeSplitNode<T>): void {
    this.next = node;
    if (node) {
      node.prev = this;
    }
  }

  /**
   * `setInsPrev` sets previous node of this node insertion.
   */
  public setInsPrev(node?: RGATreeSplitNode<T>): void {
    this.insPrev = node;
    if (node) {
      node.insNext = this;
    }
  }

  /**
   * `setInsNext` sets next node of this node insertion.
   */
  public setInsNext(node?: RGATreeSplitNode<T>): void {
    this.insNext = node;
    if (node) {
      node.insPrev = this;
    }
  }

  /**
   * `hasNext` checks if next node exists.
   */
  public hasNext(): boolean {
    return !!this.next;
  }

  /**
   * `hasInsPrev` checks if previous insertion node exists.
   */
  public hasInsPrev(): boolean {
    return !!this.insPrev;
  }

  /**
   * `isRemoved` checks if removed time exists.
   */
  public isRemoved(): boolean {
    return !!this.removedAt;
  }

  /**
   * `getRemovedAt` returns the remove time of this node.
   */
  public getRemovedAt(): TimeTicket | undefined {
    return this.removedAt;
  }

  /**
   * `split` creates a new split node of the given offset.
   */
  public split(offset: number): RGATreeSplitNode<T> {
    return new RGATreeSplitNode(
      this.id.split(offset),
      this.splitValue(offset),
      this.removedAt,
    );
  }

  /**
   * `canDelete` checks if node is able to delete.
   */
  public canDelete(
    editedAt: TimeTicket,
    clientLamportAtChange: bigint,
  ): boolean {
    const justRemoved = !this.removedAt;
    const nodeExisted =
      this.getCreatedAt().getLamport() <= clientLamportAtChange;

    if (nodeExisted && (!this.removedAt || editedAt.after(this.removedAt))) {
      return justRemoved;
    }

    return false;
  }

  /**
   * `canStyle` checks if node is able to set style.
   */
  public canStyle(
    editedAt: TimeTicket,
    clientLamportAtChange: bigint,
  ): boolean {
    const nodeExisted =
      this.getCreatedAt().getLamport() <= clientLamportAtChange;

    return nodeExisted && (!this.removedAt || editedAt.after(this.removedAt));
  }

  /**
   * `remove` removes node of given edited time.
   */
  public remove(editedAt?: TimeTicket): void {
    this.removedAt = editedAt;
  }

  /**
   * `createRange` creates ranges of RGATreeSplitPos.
   */
  public createPosRange(): RGATreeSplitPosRange {
    return [
      RGATreeSplitPos.of(this.id, 0),
      RGATreeSplitPos.of(this.id, this.getLength()),
    ];
  }

  /**
   * `getData` returns the data of this node.
   */
  public getDataSize(): DataSize {
    const dataSize = this.value.getDataSize();

    if (this.id) {
      dataSize.meta += TimeTicketSize;
    }

    if (this.removedAt) {
      dataSize.meta += TimeTicketSize;
    }

    return dataSize;
  }

  /**
   * `deepcopy` returns a new instance of this RGATreeSplitNode without structural info.
   */
  public deepcopy(): RGATreeSplitNode<T> {
    return new RGATreeSplitNode(this.id, this.value, this.removedAt);
  }

  /**
   * `toTestString` returns a String containing
   * the meta data of the node for debugging purpose.
   */
  public toTestString(): string {
    return `${this.id.toTestString()} ${this.value ? this.value : ''}`;
  }

  private splitValue(offset: number): T {
    const value = this.value;
    this.value = value.substring(0, offset) as T;
    return value.substring(offset, value.length) as T;
  }

  /**
   * `toIDString` returns a string that can be used as an ID for this position.
   */
  public toIDString(): string {
    return this.id.toIDString();
  }
}

/**
 * `RGATreeSplit` is a block-based list with improved index-based lookup in RGA.
 * The difference from RGATreeList is that it has data on a block basis to
 * reduce the size of CRDT metadata. When an edit occurs on a block,
 * the block is split.
 *
 */
export class RGATreeSplit<T extends RGATreeSplitValue> implements GCParent {
  private head: RGATreeSplitNode<T>;
  private treeByIndex: SplayTree<T>;
  private treeByID: LLRBTree<RGATreeSplitNodeID, RGATreeSplitNode<T>>;

  constructor() {
    this.head = RGATreeSplitNode.create(InitialRGATreeSplitNodeID);
    this.treeByIndex = new SplayTree();
    this.treeByID = new LLRBTree(RGATreeSplitNode.createComparator());

    this.treeByIndex.insert(this.head);
    this.treeByID.put(this.head.getID(), this.head);
  }

  /**
   * `create` creates a instance RGATreeSplit.
   */
  public static create<T extends RGATreeSplitValue>(): RGATreeSplit<T> {
    return new RGATreeSplit();
  }

  /**
   * `edit` does following steps
   * 1. split nodes with from and to
   * 2. delete between from and to
   * 3. insert a new node
   * 4. add removed node
   * @param range - range of RGATreeSplitNode
   * @param editedAt - edited time
   * @param value - value
   * @returns `[RGATreeSplitPos, Array<GCPair>, Array<Change>]`
   */
  public edit(
    range: RGATreeSplitPosRange,
    editedAt: TimeTicket,
    value?: T,
    versionVector?: VersionVector,
  ): [RGATreeSplitPos, Array<GCPair>, DataSize, Array<ValueChange<T>>] {
    const diff = { data: 0, meta: 0 };

    // 01. split nodes with from and to
    const [toLeft, diffTo, toRight] = this.findNodeWithSplit(
      range[1],
      editedAt,
    );
    const [fromLeft, diffFrom, fromRight] = this.findNodeWithSplit(
      range[0],
      editedAt,
    );

    addDataSizes(diff, diffTo, diffFrom);

    // 02. delete between from and to
    const nodesToDelete = this.findBetween(fromRight, toRight);
    const [changes, removedNodes] = this.deleteNodes(
      nodesToDelete,
      editedAt,
      versionVector,
    );

    const caretID = toRight ? toRight.getID() : toLeft.getID();
    let caretPos = RGATreeSplitPos.of(caretID, 0);

    // 03. insert a new node
    if (value) {
      const idx = this.posToIndex(fromLeft.createPosRange()[1], true);

      const inserted = this.insertAfter(
        fromLeft,
        RGATreeSplitNode.create(RGATreeSplitNodeID.of(editedAt, 0), value),
      );
      addDataSizes(diff, inserted.getDataSize());

      if (changes.length && changes[changes.length - 1].from === idx) {
        changes[changes.length - 1].value = value;
      } else {
        changes.push({
          actor: editedAt.getActorID(),
          from: idx,
          to: idx,
          value,
        });
      }

      caretPos = RGATreeSplitPos.of(
        inserted.getID(),
        inserted.getContentLength(),
      );
    }

    // 04. add removed node
    const pairs: Array<GCPair> = [];
    for (const [, removedNode] of removedNodes) {
      pairs.push({ parent: this, child: removedNode });
    }

    return [caretPos, pairs, diff, changes];
  }

  /**
   * `indexToPos` finds RGATreeSplitPos of given offset.
   */
  public indexToPos(idx: number): RGATreeSplitPos {
    const [node, offset] = this.treeByIndex.find(idx);
    const splitNode = node as RGATreeSplitNode<T>;
    return RGATreeSplitPos.of(splitNode.getID(), offset);
  }

  /**
   * `findIndexesFromRange` finds indexes based on range.
   */
  public findIndexesFromRange(range: RGATreeSplitPosRange): [number, number] {
    const [fromPos, toPos] = range;
    return [this.posToIndex(fromPos, false), this.posToIndex(toPos, true)];
  }

  /**
   * `posToIndex` converts the given position to index.
   */
  public posToIndex(pos: RGATreeSplitPos, preferToLeft: boolean): number {
    const absoluteID = pos.getAbsoluteID();
    const node = preferToLeft
      ? this.findFloorNodePreferToLeft(absoluteID)
      : this.findFloorNode(absoluteID);
    if (!node) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `the node of the given id should be found: ${absoluteID.toTestString()}`,
      );
    }
    const index = this.treeByIndex.indexOf(node!);
    const offset = node!.isRemoved()
      ? 0
      : absoluteID.getOffset() - node!.getID().getOffset();
    return index + offset;
  }

  /**
   * `findNode` finds node of given id.
   */
  public findNode(id: RGATreeSplitNodeID): RGATreeSplitNode<T> {
    return this.findFloorNode(id)!;
  }

  /**
   * `length` returns size of RGATreeSplit.
   */
  public get length(): number {
    return this.treeByIndex.length;
  }

  /**
   * `getTreeByIndex` returns the tree by index for debugging purpose.
   */
  public getTreeByIndex(): SplayTree<T> {
    return this.treeByIndex;
  }

  /**
   * `getTreeByID` returns the tree by ID for debugging purpose.
   */
  public getTreeByID(): LLRBTree<RGATreeSplitNodeID, RGATreeSplitNode<T>> {
    return this.treeByID;
  }

  /**
   * `toString` returns the string encoding of this RGATreeSplit.
   */
  public toString(): string {
    const str = [];

    for (const node of this) {
      if (!node.isRemoved()) {
        str.push(node.getValue());
      }
    }

    return str.join('');
  }

  // eslint-disable-next-line jsdoc/require-jsdoc
  public *[Symbol.iterator](): IterableIterator<RGATreeSplitNode<T>> {
    let node = this.head.getNext();
    while (node) {
      yield node;
      node = node.getNext();
    }
  }

  /**
   * `getHead` returns head of RGATreeSplitNode.
   */
  public getHead(): RGATreeSplitNode<T> {
    return this.head;
  }

  /**
   * `deepcopy` copies itself deeply.
   */
  public deepcopy(): RGATreeSplit<T> {
    const clone = new RGATreeSplit<T>();

    let node = this.head.getNext();

    let prev = clone.head;
    let current;
    while (node) {
      current = clone.insertAfter(prev, node.deepcopy());
      if (node.hasInsPrev()) {
        const insPrevNode = clone.findNode(node.getInsPrevID());
        current.setInsPrev(insPrevNode);
      }

      prev = current;
      node = node.getNext();
    }

    return clone;
  }

  /**
   * `toTestString` returns a String containing the meta data of the node
   * for debugging purpose.
   */
  public toTestString(): string {
    const result = [];

    let node: RGATreeSplitNode<T> | undefined = this.head;
    while (node) {
      if (node.isRemoved()) {
        result.push(`{${node.toTestString()}}`);
      } else {
        result.push(`[${node.toTestString()}]`);
      }

      node = node.getNext();
    }

    return result.join('');
  }

  /**
   * `insertAfter` inserts the given node after the given previous node.
   */
  public insertAfter(
    prevNode: RGATreeSplitNode<T>,
    newNode: RGATreeSplitNode<T>,
  ): RGATreeSplitNode<T> {
    const next = prevNode.getNext();
    newNode.setPrev(prevNode);
    if (next) {
      next.setPrev(newNode);
    }

    this.treeByID.put(newNode.getID(), newNode);
    this.treeByIndex.insertAfter(prevNode, newNode);

    return newNode;
  }

  /**
   * `findNodeWithSplit` splits and return nodes of the given position.
   */
  public findNodeWithSplit(
    pos: RGATreeSplitPos,
    editedAt: TimeTicket,
  ): [RGATreeSplitNode<T>, DataSize, RGATreeSplitNode<T>] {
    const absoluteID = pos.getAbsoluteID();
    let node = this.findFloorNodePreferToLeft(absoluteID);
    const relativeOffset = absoluteID.getOffset() - node.getID().getOffset();

    const [, diff] = this.splitNode(node, relativeOffset);

    while (node.hasNext() && node.getNext()!.getCreatedAt().after(editedAt)) {
      node = node.getNext()!;
    }

    return [node, diff, node.getNext()!];
  }

  private findFloorNodePreferToLeft(
    id: RGATreeSplitNodeID,
  ): RGATreeSplitNode<T> {
    let node = this.findFloorNode(id);
    if (!node) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `the node of the given id should be found: ${id.toTestString()}`,
      );
    }

    if (id.getOffset() > 0 && node!.getID().getOffset() == id.getOffset()) {
      // NOTE: InsPrev may not be present due to GC.
      if (!node!.hasInsPrev()) {
        return node!;
      }
      node = node!.getInsPrev();
    }

    return node!;
  }

  private findFloorNode(
    id: RGATreeSplitNodeID,
  ): RGATreeSplitNode<T> | undefined {
    const entry = this.treeByID.floorEntry(id);
    if (!entry) {
      return;
    }

    if (!entry.key.equals(id) && !entry.key.hasSameCreatedAt(id)) {
      return;
    }

    return entry.value;
  }

  /**
   * `findBetween` returns nodes between fromNode and toNode.
   */
  public findBetween(
    fromNode: RGATreeSplitNode<T>,
    toNode: RGATreeSplitNode<T>,
  ): Array<RGATreeSplitNode<T>> {
    const nodes = [];

    let current: RGATreeSplitNode<T> | undefined = fromNode;
    while (current && current !== toNode) {
      nodes.push(current);
      current = current.getNext();
    }

    return nodes;
  }

  private splitNode(
    node: RGATreeSplitNode<T>,
    offset: number,
  ): [RGATreeSplitNode<T> | undefined, DataSize] {
    const diff = { data: 0, meta: 0 };

    if (offset > node.getContentLength()) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `offset should be less than or equal to length`,
      );
    }

    if (offset === 0) {
      return [node, diff];
    } else if (offset === node.getContentLength()) {
      return [node.getNext(), diff];
    }

    const prvSize = node.getDataSize();

    const splitNode = node.split(offset);
    this.treeByIndex.updateWeight(splitNode);
    this.insertAfter(node, splitNode);

    const insNext = node.getInsNext();
    if (insNext) {
      insNext.setInsPrev(splitNode);
    }
    splitNode.setInsPrev(node);

    // NOTE(hackerwins): Calculate data size after node splitting:
    // Take the sum of the two split nodes(left and right) minus the size of
    // the original node. This calculates the net metadata overhead added by
    // the split operation.
    addDataSizes(diff, node.getDataSize(), splitNode.getDataSize());
    subDataSize(diff, prvSize);

    return [splitNode, diff];
  }

  private deleteNodes(
    candidates: Array<RGATreeSplitNode<T>>,
    editedAt: TimeTicket,
    versionVector?: VersionVector,
  ): [Array<ValueChange<T>>, Map<string, RGATreeSplitNode<T>>] {
    if (!candidates.length) {
      return [[], new Map()];
    }

    // There are 2 types of nodes in `candidates`: should delete, should not delete.
    // `nodesToKeep` contains nodes should not delete,
    // then is used to find the boundary of the range to be deleted.
    const [nodesToDelete, nodesToKeep] = this.filterNodes(
      candidates,
      editedAt,
      versionVector,
    );

    const removedNodes = new Map();
    // First we need to collect indexes for change.
    const changes = this.makeChanges(nodesToKeep, editedAt);
    for (const node of nodesToDelete) {
      // Then make nodes be tombstones and map that.
      removedNodes.set(node.getID().toIDString(), node);
      node.remove(editedAt);
    }
    // Finally remove index nodes of tombstones.
    this.deleteIndexNodes(nodesToKeep);

    return [changes, removedNodes];
  }

  private filterNodes(
    candidates: Array<RGATreeSplitNode<T>>,
    editedAt: TimeTicket,
    versionVector?: VersionVector,
  ): [Array<RGATreeSplitNode<T>>, Array<RGATreeSplitNode<T> | undefined>] {
    const nodesToDelete: Array<RGATreeSplitNode<T>> = [];
    const nodesToKeep: Array<RGATreeSplitNode<T> | undefined> = [];

    const [leftEdge, rightEdge] = this.findEdgesOfCandidates(candidates);
    nodesToKeep.push(leftEdge);

    for (const node of candidates) {
      const actorID = node.getCreatedAt().getActorID();
      let clientLamportAtChange = MaxLamport; // Local edit
      if (versionVector != undefined) {
        clientLamportAtChange = versionVector!.get(actorID)
          ? versionVector!.get(actorID)!
          : 0n;
      }

      if (node.canDelete(editedAt, clientLamportAtChange)) {
        nodesToDelete.push(node);
      } else {
        nodesToKeep.push(node);
      }
    }
    nodesToKeep.push(rightEdge);

    return [nodesToDelete, nodesToKeep];
  }

  /**
   * `findEdgesOfCandidates` finds the edges outside `candidates`,
   * (which has not already been deleted, or be undefined but not yet implemented)
   * right edge is undefined means `candidates` contains the end of text.
   */
  private findEdgesOfCandidates(
    candidates: Array<RGATreeSplitNode<T>>,
  ): [RGATreeSplitNode<T>, RGATreeSplitNode<T> | undefined] {
    return [
      candidates[0].getPrev()!,
      candidates[candidates.length - 1].getNext(),
    ];
  }

  private makeChanges(
    boundaries: Array<RGATreeSplitNode<T> | undefined>,
    editedAt: TimeTicket,
  ): Array<ValueChange<T>> {
    const changes: Array<ValueChange<T>> = [];
    let fromIdx: number, toIdx: number;

    for (let i = 0; i < boundaries.length - 1; i++) {
      const leftBoundary = boundaries[i];
      const rightBoundary = boundaries[i + 1];

      if (leftBoundary!.getNext() == rightBoundary) {
        continue;
      }

      [fromIdx] = this.findIndexesFromRange(
        leftBoundary!.getNext()!.createPosRange(),
      );
      if (rightBoundary) {
        [, toIdx] = this.findIndexesFromRange(
          rightBoundary.getPrev()!.createPosRange(),
        );
      } else {
        toIdx = this.treeByIndex.length;
      }

      if (fromIdx < toIdx) {
        changes.push({
          actor: editedAt.getActorID(),
          from: fromIdx,
          to: toIdx,
        });
      }
    }

    return changes.reverse();
  }

  /**
   * `deleteIndexNodes` clears the index nodes of the given deletion boundaries.
   * The boundaries mean the nodes that will not be deleted in the range.
   */
  private deleteIndexNodes(
    boundaries: Array<RGATreeSplitNode<T> | undefined>,
  ): void {
    for (let i = 0; i < boundaries.length - 1; i++) {
      const leftBoundary = boundaries[i];
      const rightBoundary = boundaries[i + 1];
      // If there is no node to delete between boundaries, do notting.
      if (leftBoundary!.getNext() != rightBoundary) {
        this.treeByIndex.deleteRange(leftBoundary!, rightBoundary);
      }
    }
  }

  /**
   * `purge` physically purges the given node from RGATreeSplit.
   */
  public purge(node: RGATreeSplitNode<T>): void {
    this.treeByIndex.delete(node);
    this.treeByID.remove(node.getID());

    const prev = node.getPrev();
    const next = node.getNext();
    const insPrev = node.getInsPrev();
    const insNext = node.getInsNext();

    if (prev) {
      prev.setNext(next);
    }
    if (next) {
      next.setPrev(prev);
    }

    node.setPrev(undefined);
    node.setNext(undefined);

    if (insPrev) {
      insPrev.setInsNext(insNext);
    }

    if (insNext) {
      insNext.setInsPrev(insPrev);
    }

    node.setInsPrev(undefined);
    node.setInsNext(undefined);
  }
}
