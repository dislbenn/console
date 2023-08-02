/* Copyright Contributors to the Open Cluster Management project */

import R from 'ramda'
import _ from 'lodash'
import {
    addResourceToModel,
    checkNotOrObjects,
    getNameWithoutPodHash,
    getNameWithoutChartRelease,
    computeResourceName,
} from '../helpers/diagram-helpers'
import {
    getClusterName,
    getRouteNameWithoutIngressHash,
    updateAppClustersMatchingSearch,
    getResourcesClustersForApp,
} from '../helpers/diagram-helpers-utils'

///////////////////////////////////////////////////////////////////////////
////////////////////// CREATE MAP OF RELATED TYPES ///////////////////////
///////////////////////////////////////////////////////////////////////////

//creates a map with all related kinds for this app, not only pod types
export const addDiagramDetails = (resourceStatuses, resourceMap, isClusterGrouped, hasHelmReleases, topology) => {
    if (checkNotOrObjects(resourceStatuses, resourceMap)) {
        return resourceMap
    }
    let related = []
    if (resourceStatuses.data.searchResult.length > 1) {
        const relatedFrist = _.get(
            mapSingleApplication(_.cloneDeep(resourceStatuses.data.searchResult[0])),
            'related',
            []
        )
        const relatedSecond = _.get(
            mapSingleApplication(_.cloneDeep(resourceStatuses.data.searchResult[1])),
            'related',
            []
        )
        related = Array.from(new Set([...relatedFrist, ...relatedSecond]))
    } else {
        related = _.get(mapSingleApplication(_.cloneDeep(resourceStatuses.data.searchResult[0])), 'related', [])
    }

    // store cluster objects and cluster names as returned by search; these are clusters related to the app
    const clustersObjects = getResourcesClustersForApp(
        R.find(R.propEq('kind', 'cluster'))(related) || {},
        topology.nodes
    )
    const clusterNamesList = R.sortBy(R.identity)(R.pluck('name')(clustersObjects))
    if (topology.nodes) {
        const appNode =
            _.find(
                topology.nodes,
                (node) => _.get(node, 'id', '').startsWith('application--') && _.get(node, 'type', '') === 'application'
            ) || {}
        const hasMultipleSubs = _.get(appNode, 'specs.allSubscriptions', []).length > 1

        topology.nodes.forEach((node) => {
            if (node.type === 'cluster') {
                // only do this for Argo clusters
                //cluster node, set search found clusters objects here
                updateAppClustersMatchingSearch(node, clustersObjects)
            }
            const nodeClusters = node.type === 'subscription' ? clusterNamesList : _.get(node, 'specs.clustersNames')
            _.set(
                node,
                'specs.searchClusters',
                hasMultipleSubs && node.type !== 'application'
                    ? _.filter(clustersObjects, (cls) => _.includes(nodeClusters, _.get(cls, 'name', '')))
                    : clustersObjects // get all search clusters when one cluster node or this is the main app node
            )
        })
        // set clusters status on the app node
        // we have all clusters information here
        const appNodeSearchClusters = _.get(appNode, 'specs.searchClusters', [])
        // search returns clusters information, use it here
        const isLocal = _.find(appNodeSearchClusters, (cls) => _.get(cls, 'name', '') === 'local-cluster')
            ? true
            : false
        _.set(appNode, 'specs.allClusters', {
            isLocal,
            remoteCount: isLocal ? appNodeSearchClusters.length - 1 : appNodeSearchClusters.length,
        })
    }
    const podIndex = _.findIndex(related, ['kind', 'pod'])
    //move pods last in the related to be processed after all resources producing pods have been processed
    //we want to add the pods to the map by using the pod hash
    let orderedList =
        podIndex === -1
            ? related
            : _.concat(_.slice(related, 0, podIndex), _.slice(related, podIndex + 1), related[podIndex])
    orderedList = _.pullAllBy(orderedList, [{ kind: 'deployable' }, { kind: 'cluster' }], 'kind')
    orderedList.forEach((kindArray) => {
        const relatedKindList = R.pathOr([], ['items'])(kindArray)
        for (let i = 0; i < relatedKindList.length; i++) {
            const { kind, cluster } = relatedKindList[i]

            if (kind === 'replicaset' && relatedKindList[i].desired === 0) {
                // skip old replicasets
                continue
            }
            //look for pod template hash and remove it from the name if there
            const { nameNoHash, deployableName } = getNameWithoutPodHash(relatedKindList[i])

            //for routes generated by Ingress, remove route name hash
            const nameNoHashIngressPod = getRouteNameWithoutIngressHash(relatedKindList[i], nameNoHash)

            const nameWithoutChartRelease = getNameWithoutChartRelease(
                relatedKindList[i],
                nameNoHashIngressPod,
                hasHelmReleases
            )

            let resourceName = computeResourceName(
                relatedKindList[i],
                deployableName,
                nameWithoutChartRelease,
                isClusterGrouped
            )

            if (
                kind === 'subscription' &&
                cluster === 'local-cluster' &&
                _.get(relatedKindList[i], 'localPlacement', '') === 'true' &&
                _.endsWith(resourceName, '-local')
            ) {
                //match local hub subscription after removing -local suffix
                resourceName = _.trimEnd(resourceName, '-local')
            }

            const resourceMapForObject = Object.values(resourceMap).find(({ name, namespace, type, specs = {} }) => {
                const replacedType = type === 'project' ? 'namespace' : type
                if (specs.resources) {
                    if (
                        replacedType === relatedKindList[i].kind &&
                        (specs.clustersNames || []).includes(relatedKindList[i].cluster)
                    ) {
                        return (
                            (specs.resources || []).findIndex((spec) => {
                                return spec.name === nameNoHash && spec.namespace === relatedKindList[i].namespace
                            }) !== -1
                        )
                    } else {
                        return false
                    }
                } else {
                    return (
                        (kind === 'subscription' ? name === resourceName : name === nameNoHash) &&
                        namespace === relatedKindList[i].namespace &&
                        replacedType === relatedKindList[i].kind &&
                        ((specs.clustersNames || []).includes(relatedKindList[i].cluster) ||
                            (specs.searchClusters || []).find((cls) => cls.name === relatedKindList[i].cluster) ||
                            relatedKindList[i].cluster === 'local-cluster') // fallback to searchclusters if SubscriptionReport is not created
                    )
                }
            })
            if (resourceMapForObject) {
                addResourceToModel(resourceMapForObject, kind, relatedKindList[i], nameWithoutChartRelease)
            }
        }
    })

    // need to preprocess and sync up podStatusMap for controllerrevision to parent
    syncControllerRevisionPodStatusMap(resourceMap)
    return resourceMap
}

export const getExistingResourceMapKey = (resourceMap, name, relatedKind) => {
    // bofore loop, find all items with the same type as relatedKind
    const isSameType = (item) => item.indexOf(`${relatedKind.kind}-`) === 0
    const keys = R.filter(isSameType, Object.keys(resourceMap))
    const relatedKindCls = _.get(relatedKind, 'cluster', '')
    let i
    for (i = 0; i < keys.length; i++) {
        const keyObject = resourceMap[keys[i]]
        const keyObjType = _.get(keyObject, 'type', '')
        const keyObjName = _.get(keyObject, 'name', '')
        if (
            (keys[i].indexOf(name) > -1 && keys[i].indexOf(relatedKindCls) > -1) || //node id doesn't contain cluster name, match cluster using the object type
            (_.includes(_.get(keyObject, 'specs.clustersNames', []), relatedKindCls) &&
                name === `${keyObjType}-${keyObjName}-${relatedKindCls}`)
        ) {
            return keys[i]
        }
    }

    return null
}

export const mapSingleApplication = (application) => {
    const items = (application ? _.get(application, 'items', []) : []) || []

    const result =
        items.length > 0
            ? _.cloneDeep(items[0])
            : {
                  name: '',
                  namespace: '',
                  dashboard: '',
                  selfLink: '',
                  _uid: '',
                  created: '',
                  apigroup: '',
                  cluster: '',
                  kind: '',
                  label: '',
                  _hubClusterResource: '',
                  _rbac: '',
                  related: [],
              }

    result.related = application ? application.related || [] : []

    items.forEach((item) => {
        //if this is an argo app, the related kinds query should be built from the items section
        //for argo we ask for namespace:targetNamespace label:appLabel kind:<comma separated string of resource kind>
        //this code moves all these items under the related section
        const kind = _.get(item, 'kind')
        const cluster = _.get(item, 'cluster')

        if (kind === 'application') {
            //this is a legit app object , just leave it
            return
        }

        if (kind === 'subscription' && cluster !== 'local-cluster') {
            // this is a legit subscription object that needs no alternation
            return
        }

        //find under the related array an object matching this kind
        const queryKind = _.filter(result.related, (filtertype) => _.get(filtertype, 'kind', '') === kind)
        //if that kind section was found add this object to it, otherwise create a new kind object for it
        const matchUID = _.filter(result.related, (filtertype) => _.get(filtertype, 'items', [])[0]?._uid === item._uid)
        const kindSection = queryKind && queryKind.length > 0 ? queryKind : { kind, items: [item] }
        if (!queryKind || queryKind.length === 0) {
            //link this kind section directly to the results array
            result.related.push(kindSection)
        } else if (matchUID) {
            // do nothing
        } else {
            kindSection[0].items.push(item)
        }
    })
    return result
}

// The controllerrevision resource doesn't contain any desired pod count so
// we need to get it from the parent; either a daemonset or statefulset
export const syncControllerRevisionPodStatusMap = (resourceMap) => {
    Object.keys(resourceMap).forEach((resourceName) => {
        if (resourceName.startsWith('controllerrevision-')) {
            const controllerRevision = resourceMap[resourceName]
            const parentName = _.get(controllerRevision, 'specs.parent.parentName', '')
            const parentType = _.get(controllerRevision, 'specs.parent.parentType', '')
            const parentId = _.get(controllerRevision, 'specs.parent.parentId', '')
            const clusterName = getClusterName(parentId).toString()
            const parentResource =
                resourceMap[`${parentType}-${parentName}-${clusterName}`] || resourceMap[`${parentType}-${parentName}-`]
            if (parentResource) {
                const parentModel = {
                    ..._.get(parentResource, `specs.${parentResource.type}Model`, ''),
                }
                if (parentModel) {
                    const currentModel = _.get(controllerRevision, 'specs.controllerrevisionModel')
                    if (currentModel) {
                        parentModel[Object.keys(parentModel)[0]][0].name =
                            currentModel[Object.keys(currentModel)[0]][0].name
                    }
                    _.set(controllerRevision, 'specs.controllerrevisionModel', parentModel)
                }
            }
        }
    })
}
