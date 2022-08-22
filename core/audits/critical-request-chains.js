/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import {Audit} from './audit.js';
import * as i18n from '../lib/i18n/i18n.js';
import ComputedChains from '../computed/critical-request-chains.js';

const UIStrings = {
  /** Imperative title of a Lighthouse audit that tells the user to reduce the depth of critical network requests to enhance initial load of a page. Critical request chains are series of dependent network requests that are important for page rendering. For example, here's a 4-request-deep chain: The biglogo.jpg image is required, but is requested via the styles.css style code, which is requested by the initialize.js javascript, which is requested by the page's HTML. This is displayed in a list of audit titles that Lighthouse generates. */
  title: 'Avoid chaining critical requests',
  /** Description of a Lighthouse audit that tells the user *why* they should reduce the depth of critical network requests to enhance initial load of a page . This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description: 'The Critical Request Chains below show you what resources are ' +
      'loaded with a high priority. Consider reducing ' +
      'the length of chains, reducing the download size of resources, or ' +
      'deferring the download of unnecessary resources to improve page load. ' +
      '[Learn how to avoid chaining critical requests](https://web.dev/critical-request-chains/).',
  /** [ICU Syntax] Label for an audit identifying the number of sequences of dependent network requests used to load the page. */
  displayValue: `{itemCount, plural,
    =1 {1 chain found}
    other {# chains found}
    }`,
};

const str_ = i18n.createIcuMessageFn(import.meta.url, UIStrings);

class CriticalRequestChains extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'critical-request-chains',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      scoreDisplayMode: Audit.SCORING_MODES.INFORMATIVE,
      supportedModes: ['navigation'],
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL'],
    };
  }

  // TODO: if we are OK with changing the audit details we can easily delete all this duplication.
  // Only difference between these trees is the shape of the network request object.
  /** @typedef {{depth: number, id: string, chainDuration: number, chainTransferSize: number, node: LH.Artifacts.CriticalRequestNode}} CrcNodeInfo */
  /** @typedef {{depth: number, id: string, chainDuration: number, chainTransferSize: number, node: LH.Audit.Details.SimpleCriticalRequestNode}} CrcNodeInfo2 */

  /**
   * @param {LH.Artifacts.CriticalRequestTree} tree
   * @param {function(CrcNodeInfo): void} cb
   */
  static _traverseArtifact(tree, cb) {
    /**
     * @param {LH.Artifacts.CriticalRequestTree} tree
     * @param {number} depth
     * @param {number=} startTime
     * @param {number=} transferSize
     */
    function walk(tree, depth, startTime, transferSize = 0) {
      const children = Object.keys(tree);
      if (children.length === 0) {
        return;
      }
      children.forEach(id => {
        const child = tree[id];
        if (!startTime) {
          startTime = child.request.mainThreadStartTime;
        }

        // Call the callback with the info for this child.
        cb({
          depth,
          id,
          node: child,
          chainDuration: (child.request.networkEndTime - startTime) / 1000,
          chainTransferSize: (transferSize + child.request.transferSize),
        });

        // Carry on walking.
        if (child.children) {
          walk(child.children, depth + 1, startTime);
        }
      }, '');
    }

    walk(tree, 0);
  }

  /**
   * @param {LH.Audit.Details.SimpleCriticalRequestTree} tree
   * @param {function(CrcNodeInfo2): void} cb
   */
  static _traverseDetails(tree, cb) {
    /**
     * @param {LH.Audit.Details.SimpleCriticalRequestTree} tree
     * @param {number} depth
     * @param {number=} startTime
     * @param {number=} transferSize
     */
    function walk(tree, depth, startTime, transferSize = 0) {
      const children = Object.keys(tree);
      if (children.length === 0) {
        return;
      }
      children.forEach(id => {
        const child = tree[id];
        if (!startTime) {
          startTime = child.request.startTime;
        }

        // Call the callback with the info for this child.
        cb({
          depth,
          id,
          node: child,
          chainDuration: child.request.endTime - startTime,
          chainTransferSize: (transferSize + child.request.transferSize),
        });

        // Carry on walking.
        if (child.children) {
          walk(child.children, depth + 1, startTime);
        }
      }, '');
    }

    walk(tree, 0);
  }

  /**
   * Get stats about the longest initiator chain (as determined by time duration)
   * @param {LH.Audit.Details.SimpleCriticalRequestTree} tree
   * @return {{duration: number, length: number, transferSize: number}}
   */
  static _getLongestChain(tree) {
    const longest = {
      duration: 0,
      length: 0,
      transferSize: 0,
    };
    CriticalRequestChains._traverseDetails(tree, opts => {
      const duration = opts.chainDuration;
      if (duration > longest.duration) {
        longest.duration = duration;
        longest.transferSize = opts.chainTransferSize;
        longest.length = opts.depth;
      }
    });
    // Always return the longest chain + 1 because the depth is zero indexed.
    longest.length++;
    return longest;
  }

  /**
   * @param {LH.Artifacts.CriticalRequestTree} tree
   * @return {LH.Audit.Details.SimpleCriticalRequestTree}
   */
  static flattenRequests(tree) {
    /** @type {LH.Audit.Details.SimpleCriticalRequestTree} */
    const flattendChains = {};
    /** @type {Map<string, LH.Audit.Details.SimpleCriticalRequestNode>} */
    const chainMap = new Map();

    /** @param {CrcNodeInfo} opts */
    function flatten(opts) {
      const request = opts.node.request;
      const simpleRequest = {
        url: request.url,
        startTime: request.mainThreadStartTime,
        endTime: request.mainThreadEndTime,
        responseReceivedTime: request.responseHeadersReceivedTime,
        transferSize: request.transferSize,
      };

      let chain = chainMap.get(opts.id);
      if (chain) {
        chain.request = simpleRequest;
      } else {
        chain = {
          request: simpleRequest,
        };
        flattendChains[opts.id] = chain;
      }

      if (opts.node.children) {
        for (const chainId of Object.keys(opts.node.children)) {
          // Note: cast should be Partial<>, but filled in when child node is traversed.
          const childChain = /** @type {LH.Audit.Details.SimpleCriticalRequestNode} */ ({
            request: {},
          });
          chainMap.set(chainId, childChain);
          if (!chain.children) {
            chain.children = {};
          }
          chain.children[chainId] = childChain;
        }
      }
      chainMap.set(opts.id, chain);
    }

    CriticalRequestChains._traverseArtifact(tree, flatten);

    return flattendChains;
  }

  /**
   * Audits the page to give a score for First Meaningful Paint.
   * @param {LH.Artifacts} artifacts The artifacts from the gather phase.
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static audit(artifacts, context) {
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    const URL = artifacts.URL;
    return ComputedChains.request({devtoolsLog, trace, URL}, context).then(chains => {
      let chainCount = 0;
      /**
       * @param {LH.Audit.Details.SimpleCriticalRequestTree} tree
       * @param {number} depth
       */
      function walk(tree, depth) {
        const childIds = Object.keys(tree);

        childIds.forEach(id => {
          const child = tree[id];
          if (child.children) {
            walk(child.children, depth + 1);
          } else {
            // if the node doesn't have a children field, then it is a leaf, so +1
            chainCount++;
          }
        }, '');
      }
      // Convert
      const flattenedChains = CriticalRequestChains.flattenRequests(chains);

      // Account for initial navigation
      const initialNavKey = Object.keys(flattenedChains)[0];
      const initialNavChildren = initialNavKey && flattenedChains[initialNavKey].children;
      if (initialNavChildren && Object.keys(initialNavChildren).length > 0) {
        walk(initialNavChildren, 0);
      }

      const longestChain = CriticalRequestChains._getLongestChain(flattenedChains);

      return {
        score: Number(chainCount === 0),
        notApplicable: chainCount === 0,
        displayValue: chainCount ? str_(UIStrings.displayValue, {itemCount: chainCount}) : '',
        details: {
          type: 'criticalrequestchain',
          chains: flattenedChains,
          longestChain,
        },
      };
    });
  }
}

export default CriticalRequestChains;
export {UIStrings};