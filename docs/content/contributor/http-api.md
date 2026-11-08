---
title: "HTTP API"
description: "The web app's API: every route, its parameters and its answers."
weight: 3030
extra:
  reader: contributor
  type: reference
---

# HTTP API

Every route Inkhold serves, 121 of them, in the order of the route table.
**Who** is the caller's scope: `public` needs no session, `device` is a
tablet, `controlplane` the browser app, `pending` a first sign-in that
must still change its password. A caller outside a route's scopes gets 403.
**Read-only** routes run on a pooled reader, **streams** take the database lock
only around their own reads and writes ([Threads and locks](@/contributor/threads-and-locks.md)).
The device routes' behaviour is in [Device protocol](@/contributor/device-protocol.md).

<!-- Generated from backend/routes.zig by docs/tools/generate.mjs. Edit the source, not this page. -->

## General

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/version` | public | `auth.version` | read-only |

## Auth

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| POST | `/api/official/user/query/random/code` | public | `auth.randomCode` | 20 per 60 s by ip |
| POST | `/api/official/user/account/login/new` | public | `auth.loginNew` | 10 per 60 s by ip |
| POST | `/api/official/user/account/login/equipment` | public | `auth.loginNew` | 10 per 60 s by ip |
| PUT | `/api/user/password` | controlplane, pending | `auth.changePassword` | 5 per 300 s by user |
| POST | `/api/user/logout` | controlplane, device, pending | `auth.logout` |  |
| GET | `/api/user/me` | controlplane, pending | `auth.me` |  |

## Device / sync

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| POST | `/api/terminal/equipment/unlink` | public | `device.unlinkEquipmentLenient` | 20 per 60 s by ip |
| POST | `/api/official/user/check/exists/server` | public | `device.checkExists` | 20 per 60 s by ip |
| GET | `/api/file/query/server` | public | `device.queryServer` | read-only |
| POST | `/api/terminal/user/bindEquipment` | device, public | `device.bindEquipment` |  |
| POST | `/api/user/query` | device | `device.userQuery` | read-only |
| POST | `/api/equipment/bind/status` | device | `device.bindStatus` | read-only |
| POST | `/api/file/capacity/query` | device | `device.capacityQuery` | read-only |
| POST | `/api/file/2/users/get_space_usage` | device | `device.getSpaceUsage` | read-only |
| POST | `/api/file/2/files/synchronous/start` | device | `device.syncStart` |  |
| POST | `/api/file/2/files/synchronous/end` | device | `device.syncEnd` |  |
| POST | `/api/file/query/summary/hash` | device | `device.digestHash` | read-only |
| POST | `/api/file/query/summary/id` | device | `device.digestById` | read-only |
| POST | `/api/file/query/summary` | device | `device.digestQuery` | read-only |
| POST | `/api/file/add/summary` | device | `device.digestAdd` |  |
| PUT | `/api/file/update/summary` | device | `device.digestUpdate` |  |
| DELETE | `/api/file/delete/summary` | device | `device.digestDelete` |  |
| POST | `/api/file/download/summary` | device | `device.digestDownload` | read-only |
| POST | `/api/file/query/summary/group` | device | `device.digestGroupQuery` | read-only |
| POST | `/api/file/add/summary/group` | device | `device.digestGroupAdd` |  |
| PUT | `/api/file/update/summary/group` | device | `device.digestGroupUpdate` |  |
| DELETE | `/api/file/delete/summary/group` | device | `device.digestGroupDelete` |  |
| GET | `/api/file/query/summary/tag` | device | `device.digestTagQuery` | read-only |
| POST | `/api/file/add/summary/tag` | device | `device.digestTagAdd` |  |
| PUT | `/api/file/update/summary/tag` | device | `device.digestTagUpdate` |  |
| DELETE | `/api/file/delete/summary/tag` | device | `device.digestTagDelete` |  |
| POST | `/api/file/2/files/list_folder` | device | `device.listFolder` | streams |
| POST | `/api/file/3/files/query/by/path_v3` | device | `device.queryByPathV3` | read-only |
| POST | `/api/file/3/files/query_v3` | device | `device.queryV3` | read-only |
| POST | `/api/file/3/files/download_v3` | device | `device.downloadV3` |  |
| POST | `/api/file/3/files/delete_folder_v3` | device | `device.deleteFolderV3` |  |
| POST | `/api/file/3/files/move_v3` | device | `device.moveV3` |  |
| POST | `/api/file/3/files/copy_v3` | device | `device.copyV3` |  |
| POST | `/api/file/2/files/create_folder_v2` | device | `device.createFolderV2` |  |
| GET | `/oss/get/:id` | public | `device.ossGet` | streams |
| POST | `/api/file/3/files/upload/apply` | device | `device.uploadApply` |  |
| POST | `/oss/put/:innerName` | device | `device.ossPut` | streams |
| POST | `/api/file/2/files/upload/finish` | device | `device.uploadFinish` |  |
| GET | `/socket.io/` | public | `device.socketIo` | streams; held stream |
| POST | `/api/file/schedule/group/all` | device | `device.todoGroupAll` |  |
| POST | `/api/file/schedule/group` | device | `device.todoGroupInsert` |  |
| PUT | `/api/file/schedule/group` | device | `device.todoGroupUpdate` |  |
| DELETE | `/api/file/schedule/group/:id` | device | `device.todoGroupDelete` |  |
| POST | `/api/file/schedule/task/all` | device | `device.todoTaskAll` |  |
| POST | `/api/file/schedule/task` | device | `device.todoTaskInsert` |  |
| PUT | `/api/file/schedule/task` | device | `device.todoTaskUpdate` |  |
| PUT | `/api/file/schedule/task/list` | device | `device.todoTaskUpdateList` |  |
| DELETE | `/api/file/schedule/task/:id` | device | `device.todoTaskDelete` |  |

## Control plane / browser

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/server-info` | public | `controlplane.serverInfo` |  |
| POST | `/api/controlplane/equipment/unlink` | controlplane | `controlplane.unlink` |  |
| GET | `/api/controlplane/tree` | controlplane | `controlplane.tree` |  |
| GET | `/api/controlplane/usage` | controlplane | `controlplane.usage` | read-only |

## The account screen: managing yourself

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/account` | controlplane | `controlplane.account` |  |
| GET | `/api/controlplane/account/storage` | controlplane | `controlplane.accountStorage` | read-only |
| POST | `/api/controlplane/account/devices/unlink` | controlplane | `controlplane.unlinkMyDevice` |  |
| POST | `/api/controlplane/account/sign-out-others` | controlplane | `controlplane.signOutOthers` |  |
| PUT | `/api/controlplane/account/versions` | controlplane | `controlplane.setVersions` |  |
| GET | `/api/controlplane/file/metadata/:id` | controlplane | `controlplane.note` |  |

## The client-side search index

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/search-index/manifest` | controlplane | `controlplane.searchIndexManifest` | read-only |
| GET | `/api/controlplane/search-index/coverage` | controlplane | `controlplane.searchCoverage` | read-only |
| GET | `/api/controlplane/search-index/stream` | controlplane | `controlplane.searchIndexStream` | streams |
| GET | `/api/controlplane/text/:md5` | controlplane | `controlplane.documentText` | streams |

## History of a file

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/note/:id/history` | controlplane | `controlplane.history` |  |
| GET | `/api/controlplane/note/:id/history/:md5/meta` | controlplane | `controlplane.historyMeta` |  |
| GET | `/api/controlplane/note/:id/history/:md5/page/:n` | controlplane | `controlplane.historyPage` | streams |
| GET | `/api/controlplane/note/:id/history/:md5/page/:n/text` | controlplane | `controlplane.historyPageText` |  |
| GET | `/api/controlplane/note/:id/history/:md5/raw` | controlplane | `controlplane.historyRaw` | streams |
| POST | `/api/controlplane/note/:id/history/:md5/restore` | controlplane | `controlplane.historyRestore` |  |
| GET | `/note/:id/page/:n` | controlplane | `controlplane.page` | streams |
| GET | `/note/:id/template/:hash` | controlplane | `controlplane.template` | streams |
| GET | `/file/:id` | controlplane | `controlplane.file` | streams |
| GET | `/thumbnail/:hash` | controlplane | `controlplane.thumbnail` | streams |
| GET | `/note/:id/page/:n/text` | controlplane | `controlplane.pageText` |  |
| GET | `/note/:id/page/:n/links` | controlplane | `controlplane.pageLinks` |  |
| GET | `/api/controlplane/events` | controlplane | `controlplane.events` | streams; held stream |

## Recycle bin

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/bin` | controlplane | `controlplane.bin` |  |
| GET | `/api/controlplane/bin/file/metadata/:id` | controlplane | `controlplane.binNote` |  |
| GET | `/api/controlplane/bin/note/:id/page/:n` | controlplane | `controlplane.binPage` | streams |
| GET | `/api/controlplane/bin/note/:id/page/:n/text` | controlplane | `controlplane.binPageText` |  |
| GET | `/api/controlplane/bin/note/:id/history` | controlplane | `controlplane.binHistory` |  |
| GET | `/api/controlplane/bin/note/:id/history/:md5/page/:n` | controlplane | `controlplane.binHistoryPage` | streams |
| GET | `/api/controlplane/bin/note/:id/history/:md5/page/:n/text` | controlplane | `controlplane.binHistoryPageText` |  |
| GET | `/api/controlplane/bin/note/:id/history/:md5/raw` | controlplane | `controlplane.binHistoryRaw` | streams |
| GET | `/api/controlplane/bin/file/:id` | controlplane | `controlplane.binFile` | streams |
| POST | `/api/controlplane/bin/:id/restore` | controlplane | `controlplane.restore` |  |
| DELETE | `/api/controlplane/bin/:id` | controlplane | `controlplane.purge` |  |
| DELETE | `/api/controlplane/bin` | controlplane | `controlplane.emptyBin` |  |
| DELETE | `/api/controlplane/entry/:id` | controlplane | `controlplane.trash` |  |
| POST | `/api/controlplane/entry/:id/rename` | controlplane | `controlplane.rename` |  |
| POST | `/api/controlplane/folder/:id/upload` | controlplane | `controlplane.upload` | streams |

## Admin: re-authentication

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| POST | `/api/admin/elevate` | controlplane | `admin.elevate` | 5 per 300 s by user |
| POST | `/api/admin/lock` | controlplane | `admin.lock` |  |

## Admin: household user management

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| POST | `/api/admin/users` | controlplane | `admin.createUser` | elevated admin |
| GET | `/api/admin/users` | controlplane | `admin.listUsers` | elevated admin |
| DELETE | `/api/admin/users/:id` | controlplane | `admin.deleteUser` | elevated admin |
| POST | `/api/admin/users/:id/reset` | controlplane | `admin.resetPassword` | elevated admin |

## Admin: one person's devices and quota

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/admin/users/:id/devices` | controlplane | `admin.listDevices` | elevated admin |
| POST | `/api/admin/users/:id/devices/unlink` | controlplane | `admin.unlinkDevice` | elevated admin |
| GET | `/api/admin/users/:id/quota` | controlplane | `admin.getQuota` | elevated admin |
| PUT | `/api/admin/users/:id/quota` | controlplane | `admin.setQuota` | elevated admin |

## Admin: server-wide settings and health

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/admin/settings/retention` | controlplane | `admin.getRetention` | elevated admin |
| PUT | `/api/admin/settings/retention` | controlplane | `admin.setRetention` | elevated admin |
| GET | `/api/admin/health` | controlplane | `admin.health` | elevated admin |

## Backups: what `inkhold backup` last did (docs/content/contributor/storage.md (Backups))

| Method | Path | Who | Handler | Notes |
|---|---|---|---|---|
| GET | `/api/controlplane/todo` | controlplane | `todoweb.get` | read-only |
| POST | `/api/controlplane/todo/lists` | controlplane | `todoweb.createList` |  |
| PUT | `/api/controlplane/todo/lists/:id` | controlplane | `todoweb.renameList` |  |
| DELETE | `/api/controlplane/todo/lists/:id` | controlplane | `todoweb.deleteList` |  |
| POST | `/api/controlplane/todo/tasks` | controlplane | `todoweb.createTask` |  |
| PUT | `/api/controlplane/todo/tasks/:id` | controlplane | `todoweb.updateTask` |  |
| DELETE | `/api/controlplane/todo/tasks/:id` | controlplane | `todoweb.deleteTask` |  |
| PUT | `/api/controlplane/todo/order` | controlplane | `todoweb.reorder` |  |
| GET | `/api/backup-notice` | controlplane | `backups.notice` | read-only |
| GET | `/api/admin/backups` | controlplane | `backups.list` | elevated admin |
| PUT | `/api/admin/backups/dismissed` | controlplane | `backups.setDismissed` | elevated admin |
| POST | `/api/admin/backups/forget` | controlplane | `backups.forget` | elevated admin |
