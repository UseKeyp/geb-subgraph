import { UserProxy } from '../../../../generated/schema'
import { Created } from "../../../../generated/ProxyFactory/DSProxyFactory";
import { getOrCreateUser, getSystemState } from '../../../entities'

import * as integer from '../../../utils/integer'
import { updateLastModifySystemState } from '../../../entities/system';

export function handleCreated(event: Created): void {
  let user = getOrCreateUser(event.params.owner)

  // Register new user proxy
  let proxy = new UserProxy(event.params.proxy.toHexString())
  proxy.address = event.params.proxy
  proxy.cache = event.params.cache
  proxy.owner = user.id
  proxy.save()

  // Update system state
  let system = getSystemState(event)
  system.proxyCount = system.proxyCount.plus(integer.ONE)
  updateLastModifySystemState(system, event)
  system.save()
}