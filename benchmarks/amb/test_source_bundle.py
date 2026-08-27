import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile

from archive_paw_longmemeval_source import MANIFEST_NAME, create_source_bundle


class LongMemEvalSourceBundleTest(unittest.TestCase):
    def test_source_bundle_is_deterministic_and_self_describing(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.zip"
            second = root / "second.zip"

            first_manifest = create_source_bundle(first)
            second_manifest = create_source_bundle(second)

            self.assertEqual(first_manifest, second_manifest)
            self.assertEqual(
                hashlib.sha256(first.read_bytes()).hexdigest(),
                hashlib.sha256(second.read_bytes()).hexdigest(),
            )
            with zipfile.ZipFile(first) as archive:
                embedded = json.loads(archive.read(MANIFEST_NAME))
                names = set(archive.namelist())
            self.assertEqual(
                first_manifest["sourceArtifactSha256"],
                embedded["sourceArtifactSha256"],
            )
            self.assertIn("packages/memory-plugin/src/evidence-first.ts", names)
            self.assertIn("packages/memory/src/longterm/store/postgres-engine.ts", names)
            self.assertNotIn(str(Path.cwd()), json.dumps(embedded))


if __name__ == "__main__":
    unittest.main()
