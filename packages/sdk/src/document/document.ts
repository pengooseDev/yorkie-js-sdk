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
import type { WatchDocumentResponse } from '@yorkie-js/sdk/src/api/yorkie/v1/yorkie_pb';
import { DocEventType as PbDocEventType } from '@yorkie-js/sdk/src/api/yorkie/v1/resources_pb';
import { Rule } from '@yorkie-js/schema';
import { validateYorkieRuleset } from '@yorkie-js/sdk/src/schema/ruleset_validator';
import { logger, LogLevel } from '@yorkie-js/sdk/src/util/logger';
import { Code, YorkieError } from '@yorkie-js/sdk/src/util/error';
import { deepcopy } from '@yorkie-js/sdk/src/util/object';
import {
  Observer,
  Observable,
  createObservable,
  Unsubscribe,
  ErrorFn,
  CompleteFn,
  NextFn,
} from '@yorkie-js/sdk/src/util/observable';
import {
  ActorID,
  InitialActorID,
} from '@yorkie-js/sdk/src/document/time/actor_id';
import {
  Change,
  ChangeStruct,
} from '@yorkie-js/sdk/src/document/change/change';
import {
  ChangeID,
  InitialChangeID,
} from '@yorkie-js/sdk/src/document/change/change_id';
import { ChangeContext } from '@yorkie-js/sdk/src/document/change/context';
import { converter } from '@yorkie-js/sdk/src/api/converter';
import { ChangePack } from '@yorkie-js/sdk/src/document/change/change_pack';
import { CRDTRoot, RootStats } from '@yorkie-js/sdk/src/document/crdt/root';
import { CRDTObject } from '@yorkie-js/sdk/src/document/crdt/object';
import {
  createJSON,
  JSONElement,
  LeafElement,
  BaseArray,
  BaseObject,
} from '@yorkie-js/sdk/src/document/json/element';
import {
  Checkpoint,
  InitialCheckpoint,
} from '@yorkie-js/sdk/src/document/change/checkpoint';
import {
  OpSource,
  OperationInfo,
  ObjectOperationInfo,
  TextOperationInfo,
  CounterOperationInfo,
  ArrayOperationInfo,
  TreeOperationInfo,
  Operation,
} from '@yorkie-js/sdk/src/document/operation/operation';
import { JSONObject } from '@yorkie-js/sdk/src/document/json/object';
import { Counter } from '@yorkie-js/sdk/src/document/json/counter';
import { Text } from '@yorkie-js/sdk/src/document/json/text';
import { Tree } from '@yorkie-js/sdk/src/document/json/tree';
import { Presence } from '@yorkie-js/sdk/src/document/presence/presence';
import { PresenceChangeType } from '@yorkie-js/sdk/src/document/presence/change';
import { History, HistoryOperation } from '@yorkie-js/sdk/src/document/history';
import { setupDevtools } from '@yorkie-js/sdk/src/devtools';
import * as Devtools from '@yorkie-js/sdk/src/devtools/types';
import { VersionVector } from './time/version_vector';
import { DocSize, totalDocSize } from '@yorkie-js/sdk/src/util/resource';

/**
 * `BroadcastOptions` are the options to create a new document.
 *
 * @public
 */
export interface BroadcastOptions {
  /**
   * `error` is called when an error occurs.
   */
  error?: ErrorFn;

  /**
   * `maxRetries` is the maximum number of retries.
   */
  maxRetries?: number;
}

/**
 * `DocumentOptions` are the options to create a new document.
 *
 * @public
 */
export interface DocumentOptions {
  /**
   * `disableGC` disables garbage collection if true.
   */
  disableGC?: boolean;

  /**
   * `enableDevtools` enables devtools if true.
   */
  enableDevtools?: boolean;
}

/**
 * `DocStatus` represents the status of the document.
 * @public
 */
export enum DocStatus {
  /**
   * Detached means that the document is not attached to the client.
   * The actor of the ticket is created without being assigned.
   */
  Detached = 'detached',
  /**
   * Attached means that this document is attached to the client.
   * The actor of the ticket is created with being assigned by the client.
   */
  Attached = 'attached',
  /**
   * Removed means that this document is removed. If the document is removed,
   * it cannot be edited.
   */
  Removed = 'removed',
}

/**
 * `DocEventType` represents the type of the event that occurs in `Document`.
 * @public
 */
export enum DocEventType {
  /**
   * status changed event type
   */
  StatusChanged = 'status-changed',

  /**
   * `ConnectionChanged` means that the watch stream connection status has changed.
   */
  ConnectionChanged = 'connection-changed',

  /**
   * `SyncStatusChanged` means that the document sync status has changed.
   */
  SyncStatusChanged = 'sync-status-changed',

  /**
   * snapshot event type
   */
  Snapshot = 'snapshot',

  /**
   * local document change event type
   */
  LocalChange = 'local-change',

  /**
   * remote document change event type
   */
  RemoteChange = 'remote-change',

  /**
   * `Initialized` means that online clients have been loaded from the server.
   */
  Initialized = 'initialized',

  /**
   * `Watched` means that the client has established a connection with the server,
   * enabling real-time synchronization.
   */
  Watched = 'watched',

  /**
   * `Unwatched` means that the connection has been disconnected.
   */
  Unwatched = 'unwatched',

  /**
   * `PresenceChanged` means that the presences of the client has updated.
   */
  PresenceChanged = 'presence-changed',

  /**
   * `Broadcast` means that the broadcast event is received from the remote client.
   */
  Broadcast = 'broadcast',

  /**
   * `LocalBroadcast` means that the broadcast event is sent from the local client.
   */
  LocalBroadcast = 'local-broadcast',

  /**
   * `AuthError` indicates an authorization failure in syncLoop or watchLoop.
   */
  AuthError = 'auth-error',
}

/**
 * `DocEvent` is an event that occurs in `Document`. It can be delivered
 * using `Document.subscribe()`.
 *
 * @public
 */
export type DocEvent<P extends Indexable = Indexable, T = OperationInfo> =
  | StatusChangedEvent
  | ConnectionChangedEvent
  | SyncStatusChangedEvent
  | SnapshotEvent
  | LocalChangeEvent<T, P>
  | RemoteChangeEvent<T, P>
  | InitializedEvent<P>
  | WatchedEvent<P>
  | UnwatchedEvent<P>
  | PresenceChangedEvent<P>
  | BroadcastEvent
  | LocalBroadcastEvent
  | AuthErrorEvent;

/**
 * `DocEvents` represents document events that occur within
 * a single transaction (e.g., doc.update).
 */
export type DocEvents<P extends Indexable = Indexable> = Array<DocEvent<P>>;

/**
 * @internal
 */
export interface BaseDocEvent {
  type: DocEventType;
}

/**
 * `StatusChangedEvent` is an event that occurs when the status of a document changes.
 *
 * @public
 */
export interface StatusChangedEvent extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.StatusChanged
   */
  type: DocEventType.StatusChanged;
  source: OpSource;
  value:
    | { status: DocStatus.Attached; actorID: string }
    | { status: DocStatus.Detached }
    | { status: DocStatus.Removed };
}

/**
 * `StreamConnectionStatus` represents whether the stream connection is connected or not.
 * @public
 */
export enum StreamConnectionStatus {
  /**
   * `Connected` means that the stream connection is connected.
   */
  Connected = 'connected',
  /**
   * `Disconnected` means that the stream connection is disconnected.
   */
  Disconnected = 'disconnected',
}

/**
 * `ConnectionChangedEvent` is an event that occurs when the stream connection state changes.
 *
 * @public
 */
export interface ConnectionChangedEvent extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.ConnectionChanged
   */
  type: DocEventType.ConnectionChanged;
  value: StreamConnectionStatus;
}

/**
 * `DocSyncStatus` represents the result of synchronizing the document with the server.
 * @public
 */
export enum DocSyncStatus {
  /**
   * `Synced` means that document synced successfully.
   */
  Synced = 'synced',
  /**
   * `SyncFiled` means that document synchronization has failed.
   */
  SyncFailed = 'sync-failed',
}

/**
 * `SyncStatusChangedEvent` is an event that occurs when document is synced with the server.
 *
 * @public
 */
export interface SyncStatusChangedEvent extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.SyncStatusChanged
   */
  type: DocEventType.SyncStatusChanged;
  value: DocSyncStatus;
}

/**
 * `SnapshotEvent` is an event that occurs when a snapshot is received from
 * the server.
 *
 * @public
 */
export interface SnapshotEvent extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.Snapshot
   */
  type: DocEventType.Snapshot;
  source: OpSource.Remote;
  value: {
    snapshot: string | undefined;
    serverSeq: string;
    snapshotVector: string;
  };
}

/**
 * `ChangeInfo` represents the modifications made during a document update
 * and the message passed.
 */
export interface ChangeInfo<T = OperationInfo> {
  message: string;
  operations: Array<T>;
  actor: ActorID;
  clientSeq: number;
  serverSeq: string;
}

/**
 * `LocalChangeEvent` is an event that occurs when the document is changed
 * by local changes.
 *
 * @public
 */
export interface LocalChangeEvent<
  T = OperationInfo,
  P extends Indexable = Indexable,
> extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.LocalChange
   */
  type: DocEventType.LocalChange;
  source: OpSource.Local | OpSource.UndoRedo;
  value: ChangeInfo<T>;
  rawChange?: ChangeStruct<P>;
}

/**
 * `RemoteChangeEvent` is an event that occurs when the document is changed
 * by remote changes.
 *
 * @public
 */
export interface RemoteChangeEvent<
  T = OperationInfo,
  P extends Indexable = Indexable,
> extends BaseDocEvent {
  /**
   * enum {@link DocEventType}.RemoteChange
   */
  type: DocEventType.RemoteChange;
  source: OpSource.Remote;
  value: ChangeInfo<T>;
  rawChange?: ChangeStruct<P>;
}

export interface InitializedEvent<P extends Indexable> extends BaseDocEvent {
  type: DocEventType.Initialized;
  source: OpSource.Local;
  value: Array<{ clientID: ActorID; presence: P }>;
}

export interface WatchedEvent<P extends Indexable> extends BaseDocEvent {
  type: DocEventType.Watched;
  source: OpSource.Remote;
  value: { clientID: ActorID; presence: P };
}

export interface UnwatchedEvent<P extends Indexable> extends BaseDocEvent {
  type: DocEventType.Unwatched;
  source: OpSource.Remote;
  value: { clientID: ActorID; presence: P };
}

export interface PresenceChangedEvent<P extends Indexable>
  extends BaseDocEvent {
  type: DocEventType.PresenceChanged;
  source: OpSource;
  value: { clientID: ActorID; presence: P };
}

export interface BroadcastEvent extends BaseDocEvent {
  type: DocEventType.Broadcast;
  value: { clientID: ActorID; topic: string; payload: Json };
  options?: BroadcastOptions;
}

export interface LocalBroadcastEvent extends BaseDocEvent {
  type: DocEventType.LocalBroadcast;
  value: { topic: string; payload: any };
  options?: BroadcastOptions;
}

export interface AuthErrorEvent extends BaseDocEvent {
  type: DocEventType.AuthError;
  value: {
    reason: string;
    method: 'PushPull' | 'WatchDocuments' | 'Broadcast';
  };
}

type DocEventCallbackMap<P extends Indexable> = {
  default: NextFn<
    | SnapshotEvent
    | LocalChangeEvent<OperationInfo, P>
    | RemoteChangeEvent<OperationInfo, P>
  >;
  presence: NextFn<
    | InitializedEvent<P>
    | WatchedEvent<P>
    | UnwatchedEvent<P>
    | PresenceChangedEvent<P>
  >;
  'my-presence': NextFn<InitializedEvent<P> | PresenceChangedEvent<P>>;
  others: NextFn<WatchedEvent<P> | UnwatchedEvent<P> | PresenceChangedEvent<P>>;
  connection: NextFn<ConnectionChangedEvent>;
  status: NextFn<StatusChangedEvent>;
  sync: NextFn<SyncStatusChangedEvent>;
  broadcast: NextFn<BroadcastEvent>;
  'local-broadcast': NextFn<LocalBroadcastEvent>;
  'auth-error': NextFn<AuthErrorEvent>;
  all: NextFn<DocEvents<P>>;
};
export type DocEventTopic = keyof DocEventCallbackMap<never>;
export type DocEventCallback<P extends Indexable> =
  DocEventCallbackMap<P>[DocEventTopic];

/**
 * `Json` represents the JSON data type. It is used to represent the data
 * structure of the document.
 */
export type Json = JsonPrimitive | JsonArray | JsonObject;

// eslint-disable-next-line @typescript-eslint/ban-types
type JsonPrimitive = string | number | boolean | null;
type JsonArray = Array<Json>;
type JsonObject = { [key: string]: Json | undefined };

/**
 * `Indexable` represents the type of the indexable object. It is used to
 * represent the presence information of the client.
 * @public
 */
export type Indexable = Record<string, Json>;

/**
 * `DocKey` represents the key of the document.
 * @public
 */
export type DocKey = string;

/**
 * `OperationInfoOfElement` represents the type of the operation info of the given element.
 */
type OperationInfoOfElement<TElement> = TElement extends Text
  ? TextOperationInfo
  : TElement extends Counter
    ? CounterOperationInfo
    : TElement extends Tree
      ? TreeOperationInfo
      : TElement extends BaseArray<any>
        ? ArrayOperationInfo
        : TElement extends BaseObject<any>
          ? ObjectOperationInfo
          : OperationInfo;

/**
 * `OperationInfoOfInternal` represents the type of the operation info of the
 * given path in the Document.subscribe.
 *
 * TODO(easylogic): If the parent is optional, children cannot be inferred.
 * TODO(easylogic): Currently, the below cases of Document.subscribe are confused.
 * ```
 *  type DocType = { obj: { key: string }, text: Text }
 *  $.obj.text ->> obj's operations
 *  $.text ->> text's operations
 * ```
 */
type OperationInfoOfInternal<
  TElement,
  TKeyOrPath,
  TDepth extends number = 0,
> = TDepth extends 0
  ? TElement
  : TKeyOrPath extends `${infer TFirst}.${infer TRest}`
    ? TFirst extends keyof TElement
      ? TElement[TFirst] extends BaseArray<unknown>
        ? OperationInfoOfInternal<
            TElement[TFirst],
            number,
            DecreasedDepthOf<TDepth>
          >
        : OperationInfoOfInternal<
            TElement[TFirst],
            TRest,
            DecreasedDepthOf<TDepth>
          >
      : OperationInfo
    : TKeyOrPath extends keyof TElement
      ? TElement[TKeyOrPath] extends BaseArray<unknown>
        ? ArrayOperationInfo
        : OperationInfoOfElement<TElement[TKeyOrPath]>
      : OperationInfo;

/**
 * `DecreasedDepthOf` represents the type of the decreased depth of the given depth.
 */
type DecreasedDepthOf<Depth extends number = 0> = Depth extends 10
  ? 9
  : Depth extends 9
    ? 8
    : Depth extends 8
      ? 7
      : Depth extends 7
        ? 6
        : Depth extends 6
          ? 5
          : Depth extends 5
            ? 4
            : Depth extends 4
              ? 3
              : Depth extends 3
                ? 2
                : Depth extends 2
                  ? 1
                  : Depth extends 1
                    ? 0
                    : -1;

/**
 * `PathOfInternal` represents the type of the path of the given element.
 */
type PathOfInternal<
  TElement,
  Prefix extends string = '',
  Depth extends number = 0,
> = Depth extends 0
  ? Prefix
  : TElement extends Record<string, any>
    ? {
        [TKey in keyof TElement]: TElement[TKey] extends LeafElement
          ? `${Prefix}${TKey & string}`
          : TElement[TKey] extends BaseArray<infer TArrayElement>
            ?
                | `${Prefix}${TKey & string}`
                | `${Prefix}${TKey & string}.${number}`
                | PathOfInternal<
                    TArrayElement,
                    `${Prefix}${TKey & string}.${number}.`,
                    DecreasedDepthOf<Depth>
                  >
            :
                | `${Prefix}${TKey & string}`
                | PathOfInternal<
                    TElement[TKey],
                    `${Prefix}${TKey & string}.`,
                    DecreasedDepthOf<Depth>
                  >;
      }[keyof TElement]
    : Prefix extends `${infer TRest}.`
      ? TRest
      : Prefix;

/**
 * `OperationInfoOf` represents the type of the operation info of the given
 * path in the Document.subscribe. It is used to remove the `$.` prefix.
 */
type OperationInfoOf<
  TDocument,
  TKey extends string = '',
  TDepth extends number = 10,
> = TKey extends `$.${infer TPath}`
  ? OperationInfoOfInternal<TDocument, TPath, TDepth>
  : OperationInfoOfInternal<TDocument, TKey, TDepth>;

/**
 * `PathOf` represents the type of the all possible paths in the Document.subscribe.
 */
type PathOf<TDocument, Depth extends number = 10> = PathOfInternal<
  TDocument,
  '$.',
  Depth
>;

/**
 * `Document` is a CRDT-based data type. We can represent the model
 * of the application and edit it even while offline.
 *
 * @public
 */
export class Document<R, P extends Indexable = Indexable> {
  private key: DocKey;
  private status: DocStatus;
  private opts: DocumentOptions;

  private changeID: ChangeID;
  private checkpoint: Checkpoint;
  private localChanges: Array<Change<P>>;
  private maxSizeLimit: number;
  private schemaRules: Array<Rule>;

  private root: CRDTRoot;
  private clone?: {
    root: CRDTRoot;
    presences: Map<ActorID, P>;
  };

  private eventStream: Observable<DocEvents<P>>;
  private eventStreamObserver!: Observer<DocEvents<P>>;

  /**
   * `onlineClients` is a set of client IDs that are currently online.
   */
  private onlineClients: Set<ActorID>;

  /**
   * `presences` is a map of client IDs to their presence information.
   */
  private presences: Map<ActorID, P>;

  /**
   * `history` is exposed to the user to manage undo/redo operations.
   */
  public history;

  /**
   * `internalHistory` is used to manage undo/redo operations internally.
   */
  public internalHistory: History<P>;

  /**
   * `isUpdating` is whether the document is updating by updater or not. It is
   * used to prevent the updater from calling undo/redo.
   */
  private isUpdating: boolean;

  constructor(key: string, opts?: DocumentOptions) {
    this.opts = opts || {};

    this.key = key;
    this.status = DocStatus.Detached;
    this.root = CRDTRoot.create();

    this.changeID = InitialChangeID;
    this.checkpoint = InitialCheckpoint;
    this.localChanges = [];
    this.maxSizeLimit = 0;
    this.schemaRules = [];

    this.eventStream = createObservable<DocEvents<P>>((observer) => {
      this.eventStreamObserver = observer;
    });

    this.onlineClients = new Set();
    this.presences = new Map();

    this.isUpdating = false;
    this.internalHistory = new History();
    this.history = {
      canUndo: this.canUndo.bind(this),
      canRedo: this.canRedo.bind(this),
      undo: this.undo.bind(this),
      redo: this.redo.bind(this),
    };

    setupDevtools(this);
  }

  /**
   * `update` executes the given updater to update this document.
   */
  public update(
    updater: (root: JSONObject<R>, presence: Presence<P>) => void,
    message?: string,
  ): void {
    if (this.getStatus() === DocStatus.Removed) {
      throw new YorkieError(Code.ErrDocumentRemoved, `${this.key} is removed`);
    }

    // 01. Update the clone object and create a change.
    this.ensureClone();
    const actorID = this.changeID.getActorID();
    const context = ChangeContext.create<P>(
      this.changeID,
      this.clone!.root,
      this.clone!.presences.get(actorID) || ({} as P),
      message,
    );

    try {
      const proxy = createJSON<JSONObject<R>>(
        context,
        this.clone!.root.getObject(),
      );

      if (!this.presences.has(actorID)) {
        this.clone!.presences.set(actorID, {} as P);
      }

      // NOTE(hackerwins): The updater should not be able to call undo/redo.
      // If the updater calls undo/redo, an error will be thrown.
      this.isUpdating = true;
      updater(
        proxy,
        new Presence(context, this.clone!.presences.get(actorID)!),
      );
    } catch (err) {
      // NOTE(hackerwins): If the updater fails, we need to remove the cloneRoot and
      // clonePresences to prevent the user from accessing the invalid state.
      this.clone = undefined;

      throw err;
    } finally {
      this.isUpdating = false;
    }

    const schemaRules = this.getSchemaRules();
    if (!context.isPresenceOnlyChange() && schemaRules.length > 0) {
      const result = validateYorkieRuleset(
        this.clone?.root.getObject(),
        schemaRules,
      );
      if (!result.valid) {
        this.clone = undefined;
        throw new YorkieError(
          Code.ErrDocumentSchemaValidationFailed,
          `schema validation failed: ${result.errors
            ?.map((error) => error.message)
            .join(', ')}`,
        );
      }
    }

    const size = totalDocSize(this.clone?.root.getDocSize());
    if (
      !context.isPresenceOnlyChange() &&
      this.maxSizeLimit > 0 &&
      this.maxSizeLimit < size
    ) {
      // NOTE(hackerwins): If the updater fails, we need to remove the cloneRoot and
      // clonePresences to prevent the user from accessing the invalid state.
      this.clone = undefined;
      throw new YorkieError(
        Code.ErrDocumentSizeExceedsLimit,
        `document size exceeded: ${size} > ${this.maxSizeLimit}`,
      );
    }

    // 02. Update the root object and presences from changes.
    if (context.hasChange()) {
      if (logger.isEnabled(LogLevel.Trivial)) {
        logger.trivial(`trying to update a local change: ${this.toJSON()}`);
      }

      const change = context.toChange();
      const { opInfos, reverseOps } = change.execute(
        this.root,
        this.presences,
        OpSource.Local,
      );
      const reversePresence = context.getReversePresence();
      if (reversePresence) {
        reverseOps.push({
          type: 'presence',
          value: reversePresence,
        });
      }

      this.localChanges.push(change);
      if (reverseOps.length > 0) {
        this.internalHistory.pushUndo(reverseOps);
      }
      // NOTE(chacha912): Clear redo when a new local operation is applied.
      if (opInfos.length > 0) {
        this.internalHistory.clearRedo();
      }
      this.changeID = context.getNextID();

      // 03. Publish the document change event.
      // NOTE(chacha912): Check opInfos, which represent the actually executed operations.
      const event: DocEvents<P> = [];
      if (opInfos.length > 0) {
        event.push({
          type: DocEventType.LocalChange,
          source: OpSource.Local,
          value: {
            message: change.getMessage() || '',
            operations: opInfos,
            actor: actorID,
            clientSeq: change.getID().getClientSeq(),
            serverSeq: change.getID().getServerSeq(),
          },
          rawChange: this.isEnableDevtools() ? change.toStruct() : undefined,
        });
      }
      if (change.hasPresenceChange()) {
        event.push({
          type: DocEventType.PresenceChanged,
          source: OpSource.Local,
          value: {
            clientID: actorID,
            presence: this.getPresence(actorID)!,
          },
        });
      }

      this.publish(event);

      if (logger.isEnabled(LogLevel.Trivial)) {
        logger.trivial(`after update a local change: ${this.toJSON()}`);
      }
    }
  }

  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the document is changed.
   */
  public subscribe(
    next: DocEventCallbackMap<P>['default'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the clients watching the document
   * establishe or update its presence.
   */
  public subscribe(
    type: 'presence',
    next: DocEventCallbackMap<P>['presence'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the current client establishes or updates its presence.
   */
  public subscribe(
    type: 'my-presence',
    next: DocEventCallbackMap<P>['my-presence'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the client establishes or terminates a connection,
   * or updates its presence.
   */
  public subscribe(
    type: 'others',
    next: DocEventCallbackMap<P>['others'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the stream connection status changes.
   */
  public subscribe(
    type: 'connection',
    next: DocEventCallbackMap<P>['connection'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the document status changes.
   */
  public subscribe(
    type: 'status',
    next: DocEventCallbackMap<P>['status'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the document is synced with the server.
   */
  public subscribe(
    type: 'sync',
    next: DocEventCallbackMap<P>['sync'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the targetPath or any of its nested values change.
   */
  public subscribe<
    TPath extends PathOf<R>,
    TOperationInfo extends OperationInfoOf<R, TPath>,
  >(
    targetPath: TPath,
    next: NextFn<
      LocalChangeEvent<TOperationInfo, P> | RemoteChangeEvent<TOperationInfo, P>
    >,
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the broadcast event is received from the remote client.
   */
  public subscribe(
    type: 'broadcast',
    next: DocEventCallbackMap<P>['broadcast'],
    error?: ErrorFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the local client sends a broadcast event.
   */
  public subscribe(
    type: 'local-broadcast',
    next: DocEventCallbackMap<P>['local-broadcast'],
    error?: ErrorFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   * The callback will be called when the authentification error occurs.
   */
  public subscribe(
    type: 'auth-error',
    next: DocEventCallbackMap<P>['auth-error'],
    error?: ErrorFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   */
  public subscribe(
    type: 'all',
    next: DocEventCallbackMap<P>['all'],
    error?: ErrorFn,
    complete?: CompleteFn,
  ): Unsubscribe;
  /**
   * `subscribe` registers a callback to subscribe to events on the document.
   */
  public subscribe<
    TPath extends PathOf<R>,
    TOperationInfo extends OperationInfoOf<R, TPath>,
  >(
    arg1: TPath | DocEventTopic | DocEventCallbackMap<P>['default'],
    arg2?:
      | NextFn<
          | LocalChangeEvent<TOperationInfo, P>
          | RemoteChangeEvent<TOperationInfo, P>
        >
      | DocEventCallback<P>
      | ErrorFn,
    arg3?: ErrorFn | CompleteFn,
    arg4?: CompleteFn,
  ): Unsubscribe {
    if (typeof arg1 === 'string') {
      if (typeof arg2 !== 'function') {
        throw new YorkieError(
          Code.ErrInvalidArgument,
          'Second argument must be a callback function',
        );
      }
      if (arg1 === 'presence') {
        const callback = arg2 as DocEventCallbackMap<P>['presence'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (
                docEvent.type !== DocEventType.Initialized &&
                docEvent.type !== DocEventType.Watched &&
                docEvent.type !== DocEventType.Unwatched &&
                docEvent.type !== DocEventType.PresenceChanged
              ) {
                continue;
              }

              callback(docEvent);
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'my-presence') {
        const callback = arg2 as DocEventCallbackMap<P>['my-presence'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (
                docEvent.type !== DocEventType.Initialized &&
                docEvent.type !== DocEventType.PresenceChanged
              ) {
                continue;
              }

              if (
                docEvent.type === DocEventType.PresenceChanged &&
                docEvent.value.clientID !== this.changeID.getActorID()
              ) {
                continue;
              }

              callback(docEvent);
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'others') {
        const callback = arg2 as DocEventCallbackMap<P>['others'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (
                docEvent.type !== DocEventType.Watched &&
                docEvent.type !== DocEventType.Unwatched &&
                docEvent.type !== DocEventType.PresenceChanged
              ) {
                continue;
              }

              if (docEvent.value.clientID !== this.changeID.getActorID()) {
                callback(docEvent);
              }
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'connection') {
        const callback = arg2 as DocEventCallbackMap<P>['connection'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (docEvent.type !== DocEventType.ConnectionChanged) {
                continue;
              }
              callback(docEvent);
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'status') {
        const callback = arg2 as DocEventCallbackMap<P>['status'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (docEvent.type !== DocEventType.StatusChanged) {
                continue;
              }
              callback(docEvent);
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'sync') {
        const callback = arg2 as DocEventCallbackMap<P>['sync'];
        return this.eventStream.subscribe(
          (event) => {
            for (const docEvent of event) {
              if (docEvent.type !== DocEventType.SyncStatusChanged) {
                continue;
              }
              callback(docEvent);
            }
          },
          arg3,
          arg4,
        );
      }
      if (arg1 === 'local-broadcast') {
        const callback = arg2 as DocEventCallbackMap<P>['local-broadcast'];
        return this.eventStream.subscribe((event) => {
          for (const docEvent of event) {
            if (docEvent.type !== DocEventType.LocalBroadcast) {
              continue;
            }

            callback(docEvent);
          }
        }, arg3);
      }
      if (arg1 === 'broadcast') {
        const callback = arg2 as DocEventCallbackMap<P>['broadcast'];
        return this.eventStream.subscribe((event) => {
          for (const docEvent of event) {
            if (docEvent.type !== DocEventType.Broadcast) {
              continue;
            }

            callback(docEvent);
          }
        }, arg3);
      }
      if (arg1 === 'auth-error') {
        const callback = arg2 as DocEventCallbackMap<P>['auth-error'];
        return this.eventStream.subscribe((event) => {
          for (const docEvent of event) {
            if (docEvent.type !== DocEventType.AuthError) {
              continue;
            }

            callback(docEvent);
          }
        }, arg3);
      }
      if (arg1 === 'all') {
        const callback = arg2 as DocEventCallbackMap<P>['all'];
        return this.eventStream.subscribe(callback, arg3, arg4);
      }
      const target = arg1;
      const callback = arg2 as NextFn<
        | LocalChangeEvent<TOperationInfo, P>
        | RemoteChangeEvent<TOperationInfo, P>
      >;
      return this.eventStream.subscribe(
        (event) => {
          for (const docEvent of event) {
            if (
              docEvent.type !== DocEventType.LocalChange &&
              docEvent.type !== DocEventType.RemoteChange
            ) {
              continue;
            }

            const targetOps: Array<TOperationInfo> = [];
            for (const op of docEvent.value.operations) {
              if (this.isSameElementOrChildOf(op.path, target)) {
                targetOps.push(op as TOperationInfo);
              }
            }
            targetOps.length &&
              callback({
                ...docEvent,
                value: { ...docEvent.value, operations: targetOps },
              });
          }
        },
        arg3,
        arg4,
      );
    }
    if (typeof arg1 === 'function') {
      const callback = arg1 as DocEventCallbackMap<P>['default'];
      const error = arg2 as ErrorFn;
      const complete = arg3 as CompleteFn;
      return this.eventStream.subscribe(
        (event) => {
          for (const docEvent of event) {
            if (
              docEvent.type !== DocEventType.Snapshot &&
              docEvent.type !== DocEventType.LocalChange &&
              docEvent.type !== DocEventType.RemoteChange
            ) {
              continue;
            }

            callback(docEvent);
          }
        },
        error,
        complete,
      );
    }

    throw new YorkieError(Code.ErrInvalidArgument, `"${arg1}" is not a valid`);
  }

  /**
   * `publish` triggers an event in this document, which can be received by
   * callback functions from document.subscribe().
   */
  public publish(event: DocEvents<P>) {
    if (this.eventStreamObserver) {
      this.eventStreamObserver.next(event);
    }
  }

  private isSameElementOrChildOf(elem: string, parent: string): boolean {
    if (parent === elem) {
      return true;
    }

    const nodePath = elem.split('.');
    const targetPath = parent.split('.');
    return targetPath.every((path, index) => path === nodePath[index]);
  }

  /**
   * `removePushedLocalChanges` removes local changes that have been applied to
   * the server from the local changes.
   *
   * @param clientSeq - client sequence number to remove local changes before it
   */
  private removePushedLocalChanges(clientSeq: number) {
    while (this.localChanges.length) {
      const change = this.localChanges[0];
      if (change.getID().getClientSeq() > clientSeq) {
        break;
      }
      this.localChanges.shift();
    }
  }

  /**
   * `applyChangePack` applies the given change pack into this document.
   * 1. Remove local changes applied to server.
   * 2. Update the checkpoint.
   * 3. Do Garbage collection.
   *
   * @param pack - change pack
   * @internal
   */
  public applyChangePack(pack: ChangePack<P>): void {
    const hasSnapshot = pack.hasSnapshot();

    // 01. Apply snapshot or changes to the root object.
    if (hasSnapshot) {
      this.applySnapshot(
        pack.getCheckpoint().getServerSeq(),
        pack.getVersionVector()!,
        pack.getSnapshot()!,
        pack.getCheckpoint().getClientSeq(),
      );
    } else {
      this.applyChanges(pack.getChanges(), OpSource.Remote);
      this.removePushedLocalChanges(pack.getCheckpoint().getClientSeq());
    }

    // 02. Update the checkpoint.
    this.checkpoint = this.checkpoint.forward(pack.getCheckpoint());

    // 03. Do Garbage collection.
    if (!hasSnapshot) {
      this.garbageCollect(pack.getVersionVector()!);
    }

    // 04. Update the status.
    if (pack.getIsRemoved()) {
      this.applyStatus(DocStatus.Removed);
    }

    if (logger.isEnabled(LogLevel.Trivial)) {
      logger.trivial(`${this.root.toJSON()}`);
    }
  }

  /**
   * `getCheckpoint` returns the checkpoint of this document.
   *
   * @internal
   */
  public getCheckpoint(): Checkpoint {
    return this.checkpoint;
  }

  /**
   * `getChangeID` returns the change id of this document.
   *
   * @internal
   */
  public getChangeID(): ChangeID {
    return this.changeID;
  }

  /**
   * `hasLocalChanges` returns whether this document has local changes or not.
   */
  public hasLocalChanges(): boolean {
    return this.localChanges.length > 0;
  }

  /**
   * `ensureClone` make a clone of root.
   *
   * @internal
   */
  public ensureClone(): void {
    if (this.clone) {
      return;
    }

    this.clone = {
      root: this.root.deepcopy(),
      presences: deepcopy(this.presences),
    };
  }

  /**
   * `createChangePack` create change pack of the local changes to send to the
   * remote server.
   *
   * @internal
   */
  public createChangePack(): ChangePack<P> {
    const changes = Array.from(this.localChanges);
    const checkpoint = this.checkpoint.increaseClientSeq(changes.length);
    return ChangePack.create(
      this.key,
      checkpoint,
      false,
      changes,
      this.getVersionVector(),
    );
  }

  /**
   * `setActor` sets actor into this document. This is also applied in the local
   * changes the document has.
   *
   * @internal
   */
  public setActor(actorID: ActorID): void {
    for (const change of this.localChanges) {
      change.setActor(actorID);
    }
    this.changeID = this.changeID.setActor(actorID);

    // TODO(hackerwins): If the given actorID is not IntialActorID, we need to
    // update InitialActor of the root and clone.
  }

  /**
   * `isEnableDevtools` returns whether devtools is enabled or not.
   */
  public isEnableDevtools(): boolean {
    return !!this.opts.enableDevtools;
  }

  /**
   * `getKey` returns the key of this document.
   */
  public getKey(): string {
    return this.key;
  }

  /**
   * `getStatus` returns the status of this document.
   */
  public getStatus(): DocStatus {
    return this.status;
  }

  /**
   * `getClone` returns this clone.
   */
  public getClone() {
    return this.clone;
  }

  /**
   * `getCloneRoot` returns clone object.
   *
   * @internal
   */
  public getCloneRoot(): CRDTObject | undefined {
    if (!this.clone) {
      return;
    }

    return this.clone.root.getObject();
  }

  /**
   * `getRoot` returns a new proxy of cloned root.
   */
  public getRoot(): JSONObject<R> {
    this.ensureClone();

    const context = ChangeContext.create(
      this.changeID.next(),
      this.clone!.root,
      this.clone!.presences.get(this.changeID.getActorID()) || ({} as P),
    );
    return createJSON<R>(context, this.clone!.root.getObject());
  }

  /**
   * `getDocSize` returns the size of this document.
   */
  public getDocSize(): DocSize {
    return this.root.getDocSize();
  }

  /**
   * `getMaxSizePerDocument` gets the maximum size of this document.
   */
  public getMaxSizePerDocument() {
    return this.maxSizeLimit;
  }

  /**
   * `setMaxSizePerDocument` sets the maximum size of this document.
   */
  public setMaxSizePerDocument(size: number) {
    this.maxSizeLimit = size;
  }

  /**
   * `getSchemaRules` gets the schema rules of this document.
   */
  public getSchemaRules() {
    return this.schemaRules;
  }

  /**
   * `setSchemaRules` sets the schema rules of this document.
   */
  public setSchemaRules(rules: Array<Rule>) {
    this.schemaRules = rules;
  }

  /**
   * `garbageCollect` purges elements that were removed before the given time.
   *
   * @internal
   */
  public garbageCollect(minSyncedVersionVector: VersionVector): number {
    if (this.opts.disableGC) {
      return 0;
    }

    if (this.clone) {
      this.clone.root.garbageCollect(minSyncedVersionVector);
    }
    return this.root.garbageCollect(minSyncedVersionVector);
  }

  /**
   * `getRootObject` returns root object.
   *
   * @internal
   */
  public getRootObject(): CRDTObject {
    return this.root.getObject();
  }

  /**
   * `getGarbageLen` returns the length of elements should be purged.
   *
   * @internal
   */
  public getGarbageLen(): number {
    return this.root.getGarbageLen();
  }

  /**
   * `getGarbageLenFromClone` returns the length of elements should be purged from clone.
   */
  public getGarbageLenFromClone(): number {
    return this.clone!.root.getGarbageLen();
  }

  /**
   * `toJSON` returns the JSON encoding of this document.
   */
  public toJSON(): string {
    return this.root.toJSON();
  }

  /**
   * `toSortedJSON` returns the sorted JSON encoding of this document.
   */
  public toSortedJSON(): string {
    return this.root.toSortedJSON();
  }

  /**
   * `getStats` returns the statistics of this document.
   */
  public getStats(): RootStats {
    return this.root.getStats();
  }

  /**
   * `toJSForTest` returns value with meta data for testing.
   */
  public toJSForTest(): Devtools.JSONElement {
    return {
      ...this.getRoot().toJSForTest!(),
      key: 'root',
    };
  }

  /**
   * `applySnapshot` applies the given snapshot into this document.
   */
  public applySnapshot(
    serverSeq: bigint,
    snapshotVector: VersionVector,
    snapshot?: Uint8Array,
    clientSeq: number = -1,
  ) {
    const { root, presences } = converter.bytesToSnapshot<P>(snapshot);
    this.root = new CRDTRoot(root);
    this.presences = presences;
    this.changeID = this.changeID.setClocks(
      snapshotVector.maxLamport(),
      snapshotVector,
    );

    // drop clone because it is contaminated.
    this.clone = undefined;

    this.removePushedLocalChanges(clientSeq);

    // NOTE(hackerwins): If the document has local changes, we need to apply
    // them after applying the snapshot, as local changes are not included in the snapshot data.
    // Afterward, we should publish a snapshot event with the latest
    // version of the document to ensure the user receives the most up-to-date snapshot.
    this.applyChanges(this.localChanges, OpSource.Local);
    this.publish([
      {
        type: DocEventType.Snapshot,
        source: OpSource.Remote,
        value: {
          serverSeq: serverSeq.toString(),
          snapshot: this.isEnableDevtools()
            ? converter.bytesToHex(snapshot)
            : undefined,
          snapshotVector: converter.versionVectorToHex(snapshotVector),
        },
      },
    ]);
  }

  /**
   * `applyChanges` applies the given changes into this document.
   */
  public applyChanges(changes: Array<Change<P>>, source: OpSource): void {
    if (logger.isEnabled(LogLevel.Debug)) {
      logger.debug(
        `trying to apply ${changes.length} remote changes.` +
          `elements:${this.root.getElementMapSize()}, ` +
          `removeds:${this.root.getGarbageElementSetSize()}`,
      );
    }
    if (logger.isEnabled(LogLevel.Trivial)) {
      logger.trivial(
        changes
          .map(
            (change) =>
              `${change.getID().toTestString()}\t${change.toTestString()}`,
          )
          .join('\n'),
      );
    }

    for (const change of changes) {
      this.applyChange(change, source);
    }

    if (logger.isEnabled(LogLevel.Debug)) {
      logger.debug(
        `after appling ${changes.length} remote changes.` +
          `elements:${this.root.getElementMapSize()}, ` +
          ` removeds:${this.root.getGarbageElementSetSize()}`,
      );
    }
  }

  /**
   * `applyChange` applies the given change into this document.
   */
  public applyChange(change: Change<P>, source: OpSource) {
    this.ensureClone();
    change.execute(this.clone!.root, this.clone!.presences, source);

    const event: DocEvents<P> = [];
    const actorID = change.getID().getActorID();
    if (change.hasPresenceChange() && this.onlineClients.has(actorID)) {
      const presenceChange = change.getPresenceChange()!;
      switch (presenceChange.type) {
        case PresenceChangeType.Put:
          // NOTE(chacha912): When the user exists in onlineClients, but
          // their presence was initially absent, we can consider that we have
          // received their initial presence, so trigger the 'watched' event.

          event.push(
            this.presences.has(actorID)
              ? {
                  type: DocEventType.PresenceChanged,
                  source,
                  value: {
                    clientID: actorID,
                    presence: presenceChange.presence,
                  },
                }
              : {
                  type: DocEventType.Watched,
                  source: OpSource.Remote,
                  value: {
                    clientID: actorID,
                    presence: presenceChange.presence,
                  },
                },
          );
          break;
        case PresenceChangeType.Clear:
          // NOTE(chacha912): When the user exists in onlineClients, but
          // PresenceChange(clear) is received, we can consider it as detachment
          // occurring before unwatching.
          // Detached user is no longer participating in the document, we remove
          // them from the online clients and trigger the 'unwatched' event.
          event.push({
            type: DocEventType.Unwatched,
            source: OpSource.Remote,
            value: {
              clientID: actorID,
              presence: this.getPresence(actorID)!,
            },
          });
          this.removeOnlineClient(actorID);
          break;
        default:
          break;
      }
    }

    const { opInfos } = change.execute(this.root, this.presences, source);
    this.changeID = this.changeID.syncClocks(change.getID());
    if (opInfos.length > 0) {
      const rawChange = this.isEnableDevtools() ? change.toStruct() : undefined;
      event.push(
        source === OpSource.Remote
          ? {
              type: DocEventType.RemoteChange,
              source,
              value: {
                actor: actorID,
                clientSeq: change.getID().getClientSeq(),
                serverSeq: change.getID().getServerSeq(),
                message: change.getMessage() || '',
                operations: opInfos,
              },
              rawChange,
            }
          : {
              type: DocEventType.LocalChange,
              source,
              value: {
                actor: actorID,
                clientSeq: change.getID().getClientSeq(),
                serverSeq: change.getID().getServerSeq(),
                message: change.getMessage() || '',
                operations: opInfos,
              },
              rawChange,
            },
      );
    }
    // DocEvent should be emitted synchronously with applying changes.
    // This is because 3rd party model should be synced with the Document
    // after RemoteChange event is emitted. If the event is emitted
    // asynchronously, the model can be changed and breaking consistency.
    if (event.length > 0) {
      this.publish(event);
    }
  }

  /**
   * `applyWatchStream` applies the given watch stream response into this document.
   */
  public applyWatchStream(resp: WatchDocumentResponse) {
    if (resp.body.case === 'initialization') {
      const clientIDs = resp.body.value.clientIds;
      const onlineClients: Set<ActorID> = new Set();
      for (const clientID of clientIDs) {
        if (clientID === this.changeID.getActorID()) {
          continue;
        }
        onlineClients.add(clientID);
      }
      this.setOnlineClients(onlineClients);

      this.publish([
        {
          type: DocEventType.Initialized,
          source: OpSource.Local,
          value: this.getPresences(),
        },
      ]);
      return;
    }

    if (resp.body.case === 'event') {
      const { type, publisher } = resp.body.value;
      const event: Array<WatchedEvent<P> | UnwatchedEvent<P> | BroadcastEvent> =
        [];
      if (type === PbDocEventType.DOCUMENT_WATCHED) {
        if (this.onlineClients.has(publisher) && this.hasPresence(publisher)) {
          return;
        }

        this.addOnlineClient(publisher);
        // NOTE(chacha912): We added to onlineClients, but we won't trigger watched event
        // unless we also know their initial presence data at this point.
        if (this.hasPresence(publisher)) {
          event.push({
            type: DocEventType.Watched,
            source: OpSource.Remote,
            value: {
              clientID: publisher,
              presence: this.getPresence(publisher)!,
            },
          });
        }
      } else if (type === PbDocEventType.DOCUMENT_UNWATCHED) {
        const presence = this.getPresence(publisher);
        this.removeOnlineClient(publisher);
        // NOTE(chacha912): There is no presence, when PresenceChange(clear) is applied before unwatching.
        // In that case, the 'unwatched' event is triggered while handling the PresenceChange.
        if (presence) {
          event.push({
            type: DocEventType.Unwatched,
            source: OpSource.Remote,
            value: { clientID: publisher, presence },
          });
        }
      } else if (type === PbDocEventType.DOCUMENT_BROADCAST) {
        if (resp.body.value.body) {
          const { topic, payload } = resp.body.value.body;
          const decoder = new TextDecoder();

          event.push({
            type: DocEventType.Broadcast,
            value: {
              clientID: publisher,
              topic,
              payload: JSON.parse(decoder.decode(payload)),
            },
          });
        }
      }

      if (event.length > 0) {
        this.publish(event);
      }
    }
  }

  /**
   * `applyStatus` applies the document status into this document.
   */
  public applyStatus(status: DocStatus) {
    this.status = status;

    if (status === DocStatus.Detached) {
      this.setActor(InitialActorID);
    }

    this.publish([
      {
        source: status === DocStatus.Removed ? OpSource.Remote : OpSource.Local,
        type: DocEventType.StatusChanged,
        value:
          status === DocStatus.Attached
            ? { status, actorID: this.changeID.getActorID() }
            : { status },
      },
    ]);
  }

  /**
   * `applyDocEventForReplay` applies the given event into this document.
   */
  public applyDocEventForReplay(event: Devtools.DocEventForReplay<P>) {
    if (event.type === DocEventType.StatusChanged) {
      this.applyStatus(event.value.status);
      if (event.value.status === DocStatus.Attached) {
        this.setActor(event.value.actorID);
      }
      return;
    }

    if (event.type === DocEventType.Snapshot) {
      const { snapshot, serverSeq, snapshotVector } = event.value;
      if (!snapshot) return;

      // TODO(hackerwins): We need to check version vector and lamport clock
      // of the snapshot is valid.
      this.applySnapshot(
        BigInt(serverSeq),
        converter.hexToVersionVector(snapshotVector),
        converter.hexToBytes(snapshot),
      );
      return;
    }

    if (
      event.type === DocEventType.LocalChange ||
      event.type === DocEventType.RemoteChange
    ) {
      if (!event.rawChange) return;
      const change = Change.fromStruct<P>(event.rawChange);
      this.applyChange(change, event.source);
    }

    if (event.type === DocEventType.Initialized) {
      const onlineClients: Set<ActorID> = new Set();
      for (const { clientID, presence } of event.value) {
        onlineClients.add(clientID);
        this.presences.set(clientID, presence);
      }
      this.setOnlineClients(onlineClients);
      return;
    }

    if (event.type === DocEventType.Watched) {
      const { clientID, presence } = event.value;
      this.addOnlineClient(clientID);
      this.presences.set(clientID, presence);
      return;
    }

    if (event.type === DocEventType.Unwatched) {
      const { clientID } = event.value;
      this.removeOnlineClient(clientID);
      this.presences.delete(clientID);
    }

    if (event.type === DocEventType.PresenceChanged) {
      const { clientID, presence } = event.value;
      this.presences.set(clientID, presence);
    }
  }

  /**
   * `applyDocEventsForReplay` applies the given events into this document.
   */
  public applyDocEventsForReplay(event: Array<Devtools.DocEventForReplay<P>>) {
    for (const docEvent of event) {
      this.applyDocEventForReplay(docEvent);
    }
  }

  /**
   * `getValueByPath` returns the JSONElement corresponding to the given path.
   */
  public getValueByPath(path: string): JSONElement | undefined {
    if (!path.startsWith('$')) {
      throw new YorkieError(
        Code.ErrInvalidArgument,
        `path must start with "$"`,
      );
    }
    const pathArr = path.split('.');
    pathArr.shift();
    let value: JSONObject<any> = this.getRoot();
    for (const key of pathArr) {
      value = value[key];
      if (value === undefined) return undefined;
    }
    return value;
  }

  /**
   * `setOnlineClients` sets the given online client set.
   *
   * @internal
   */
  public setOnlineClients(onlineClients: Set<ActorID>) {
    this.onlineClients = onlineClients;
  }

  /**
   * `resetOnlineClients` resets the online client set.
   *
   * @internal
   */
  public resetOnlineClients() {
    this.onlineClients = new Set();
  }

  /**
   * `addOnlineClient` adds the given clientID into the online client set.
   *
   * @internal
   */
  public addOnlineClient(clientID: ActorID) {
    this.onlineClients.add(clientID);
  }

  /**
   * `removeOnlineClient` removes the clientID from the online client set.
   *
   * @internal
   */
  public removeOnlineClient(clientID: ActorID) {
    this.onlineClients.delete(clientID);
  }

  /**
   * `hasPresence` returns whether the given clientID has a presence or not.
   *
   * @internal
   */
  public hasPresence(clientID: ActorID): boolean {
    return this.presences.has(clientID);
  }

  /**
   * `getMyPresence` returns the presence of the current client.
   */
  public getMyPresence(): P {
    // TODO(chacha912): After resolving the presence initialization issue,
    // remove default presence.(#608)
    if (this.status !== DocStatus.Attached) {
      return {} as P;
    }

    const p = this.presences.get(this.changeID.getActorID())!;
    return p ? deepcopy(p) : ({} as P);
  }

  /**
   * `getPresence` returns the presence of the given clientID.
   */
  public getPresence(clientID: ActorID): P | undefined {
    if (clientID === this.changeID.getActorID()) {
      return this.getMyPresence();
    }

    if (!this.onlineClients.has(clientID)) return;
    const p = this.presences.get(clientID);
    return p ? deepcopy(p) : undefined;
  }

  /**
   * `getPresenceForTest` returns the presence of the given clientID
   * regardless of whether the client is online or not.
   *
   * @internal
   */
  public getPresenceForTest(clientID: ActorID): P | undefined {
    const p = this.presences.get(clientID);
    return p ? deepcopy(p) : undefined;
  }

  /**
   * `getPresences` returns the presences of online clients.
   */
  public getPresences(): Array<{ clientID: ActorID; presence: P }> {
    const presences: Array<{ clientID: ActorID; presence: P }> = [];
    presences.push({
      clientID: this.changeID.getActorID(),
      presence: deepcopy(this.getMyPresence()),
    });

    for (const clientID of this.onlineClients) {
      if (this.presences.has(clientID)) {
        presences.push({
          clientID,
          presence: deepcopy(this.presences.get(clientID)!),
        });
      }
    }
    return presences;
  }

  /**
   * `getSelfForTest` returns the client that has attached this document.
   *
   * @internal
   */
  public getSelfForTest() {
    return {
      clientID: this.getChangeID().getActorID(),
      presence: this.getMyPresence(),
    };
  }

  /**
   * `getOthersForTest` returns all the other clients in online, sorted by clientID.
   *
   * @internal
   */
  public getOthersForTest() {
    const myClientID = this.getChangeID().getActorID();

    return this.getPresences()
      .filter((a) => a.clientID !== myClientID)
      .sort((a, b) => (a.clientID > b.clientID ? 1 : -1));
  }

  /**
   * `canUndo` returns whether there are any operations to undo.
   */
  private canUndo(): boolean {
    return this.internalHistory.hasUndo() && !this.isUpdating;
  }

  /**
   * `canRedo` returns whether there are any operations to redo.
   */
  private canRedo(): boolean {
    return this.internalHistory.hasRedo() && !this.isUpdating;
  }

  /**
   * `undo` undoes the last operation executed by the current client.
   * It does not impact operations made by other clients.
   */
  private undo(): void {
    if (this.isUpdating) {
      throw new YorkieError(
        Code.ErrRefused,
        'Undo is not allowed during an update',
      );
    }
    const undoOps = this.internalHistory.popUndo();
    if (undoOps === undefined) {
      throw new YorkieError(
        Code.ErrRefused,
        'There is no operation to be undone',
      );
    }

    this.ensureClone();
    // TODO(chacha912): After resolving the presence initialization issue,
    // remove default presence.(#608)
    const context = ChangeContext.create<P>(
      this.changeID,
      this.clone!.root,
      this.clone!.presences.get(this.changeID.getActorID()) || ({} as P),
    );

    // apply undo operation in the context to generate a change
    for (const undoOp of undoOps) {
      if (!(undoOp instanceof Operation)) {
        // apply presence change to the context
        const presence = new Presence<P>(
          context,
          deepcopy(this.clone!.presences.get(this.changeID.getActorID())!),
        );
        presence.set(undoOp.value, { addToHistory: true });
        continue;
      }
      const ticket = context.issueTimeTicket();
      undoOp.setExecutedAt(ticket);
      context.push(undoOp);
    }

    const change = context.toChange();
    change.execute(this.clone!.root, this.clone!.presences, OpSource.UndoRedo);

    const { opInfos, reverseOps } = change.execute(
      this.root,
      this.presences,
      OpSource.UndoRedo,
    );
    const reversePresence = context.getReversePresence();
    if (reversePresence) {
      reverseOps.push({
        type: 'presence',
        value: reversePresence,
      });
    }
    if (reverseOps.length > 0) {
      this.internalHistory.pushRedo(reverseOps);
    }

    // NOTE(chacha912): When there is no applied operation or presence
    // during undo/redo, skip propagating change remotely.
    if (!change.hasPresenceChange() && opInfos.length === 0) {
      return;
    }

    this.localChanges.push(change);
    this.changeID = context.getNextID();
    const actorID = this.changeID.getActorID();
    const event: DocEvents<P> = [];
    if (opInfos.length > 0) {
      event.push({
        type: DocEventType.LocalChange,
        source: OpSource.UndoRedo,
        value: {
          message: change.getMessage() || '',
          operations: opInfos,
          actor: actorID,
          clientSeq: change.getID().getClientSeq(),
          serverSeq: change.getID().getServerSeq(),
        },
        rawChange: this.isEnableDevtools() ? change.toStruct() : undefined,
      });
    }
    if (change.hasPresenceChange()) {
      event.push({
        type: DocEventType.PresenceChanged,
        source: OpSource.UndoRedo,
        value: {
          clientID: actorID,
          presence: this.getPresence(actorID)!,
        },
      });
    }
    this.publish(event);
  }

  /**
   * `redo` redoes the last operation executed by the current client.
   * It does not impact operations made by other clients.
   */
  private redo(): void {
    if (this.isUpdating) {
      throw new YorkieError(
        Code.ErrRefused,
        'Redo is not allowed during an update',
      );
    }

    const redoOps = this.internalHistory.popRedo();
    if (redoOps === undefined) {
      throw new YorkieError(
        Code.ErrRefused,
        'There is no operation to be redone',
      );
    }

    this.ensureClone();
    const context = ChangeContext.create<P>(
      this.changeID,
      this.clone!.root,
      this.clone!.presences.get(this.changeID.getActorID()) || ({} as P),
    );

    // apply redo operation in the context to generate a change
    for (const redoOp of redoOps) {
      if (!(redoOp instanceof Operation)) {
        // apply presence change to the context
        const presence = new Presence<P>(
          context,
          deepcopy(this.clone!.presences.get(this.changeID.getActorID())!),
        );
        presence.set(redoOp.value, { addToHistory: true });
        continue;
      }
      const ticket = context.issueTimeTicket();
      redoOp.setExecutedAt(ticket);
      context.push(redoOp);
    }

    const change = context.toChange();
    change.execute(this.clone!.root, this.clone!.presences, OpSource.UndoRedo);

    const { opInfos, reverseOps } = change.execute(
      this.root,
      this.presences,
      OpSource.UndoRedo,
    );
    const reversePresence = context.getReversePresence();
    if (reversePresence) {
      reverseOps.push({
        type: 'presence',
        value: reversePresence,
      });
    }
    if (reverseOps.length > 0) {
      this.internalHistory.pushUndo(reverseOps);
    }

    // NOTE(chacha912): When there is no applied operation or presence
    // during undo/redo, skip propagating change remotely.
    if (!change.hasPresenceChange() && opInfos.length === 0) {
      return;
    }

    this.localChanges.push(change);
    this.changeID = context.getNextID();
    const actorID = this.changeID.getActorID();
    const event: DocEvents<P> = [];
    if (opInfos.length > 0) {
      event.push({
        type: DocEventType.LocalChange,
        source: OpSource.UndoRedo,
        value: {
          message: change.getMessage() || '',
          operations: opInfos,
          actor: actorID,
          clientSeq: change.getID().getClientSeq(),
          serverSeq: change.getID().getServerSeq(),
        },
        rawChange: this.isEnableDevtools() ? change.toStruct() : undefined,
      });
    }
    if (change.hasPresenceChange()) {
      event.push({
        type: DocEventType.PresenceChanged,
        source: OpSource.UndoRedo,
        value: {
          clientID: actorID,
          presence: this.getPresence(actorID)!,
        },
      });
    }
    this.publish(event);
  }

  /**
   * `getUndoStackForTest` returns the undo stack for test.
   */
  public getUndoStackForTest(): Array<Array<HistoryOperation<P>>> {
    return this.internalHistory.getUndoStackForTest();
  }

  /**
   * `getRedoStackForTest` returns the redo stack for test.
   */
  public getRedoStackForTest(): Array<Array<HistoryOperation<P>>> {
    return this.internalHistory.getRedoStackForTest();
  }

  /**
   * `broadcast` the payload to the given topic.
   */
  public broadcast(topic: string, payload: Json, options?: BroadcastOptions) {
    const broadcastEvent: LocalBroadcastEvent = {
      type: DocEventType.LocalBroadcast,
      value: { topic, payload },
      options,
    };

    this.publish([broadcastEvent]);
  }

  /**
   * `getVersionVector` returns the version vector of document
   */
  public getVersionVector() {
    return this.changeID.getVersionVector();
  }
}
